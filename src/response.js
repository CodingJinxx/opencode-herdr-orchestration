import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
// Response matrix (21-M2 load-bearing layer): Herdr prompt patterns are
// name-based and cannot encode worker role, so governor prompts stay broad as
// far as text matchers permit. Prompt bans plus start denial (spawn matrix
// allows only grazer and sheepdog for the governor) plus this matrix (retrieval
// allows only grazer and sheepdog for the governor) enforce the boundary.
// Bypass retrieval attempts fail closed with UNSUPPORTED_WORKER_ROLE and must
// surface as STOP plus a configuration failure naming the missing capability,
// never auto-fallback to direct sheep execution.
export const RESPONSE_MATRIX = new Map([
  ["shepherd", new Set(["grazer"])],
  ["shepherd-governor", new Set(["grazer", "sheepdog"])],
  ["sheepdog", new Set(["grazer", "sheep", "shearer-low", "shearer-medium"])],
]);
const SETTLED_STATES = new Set(["idle", "done"]);
// 20-M1 responsive wait taxonomy (bounded `herdr agent get` polling default; no
// event stream evidenced in-repo, so no stream command is invented). Evidenced
// vocabulary: `idle`/`done` settled, `working` continue, `blocked` inspect with
// never blind input, missing/`unknown` inconclusive. `error`/`failed` is the
// explicit error shape handled distinctly as AGENT_ERROR; any other
// unrecognized status stays inconclusive (AGENT_NOT_SETTLED) to avoid inventing
// CLI behavior. Disappearance (`agent_not_found`) stays AGENT_NOT_FOUND with an
// explicit report. Command failures stay HERDR_UNAVAILABLE immediately, never
// decayed to timeout. Safety timeout expiry is the prompt-level final bound and
// surfaces as WAIT_TIMEOUT_EXPIRED via waitTimeoutError, distinct from early
// failures. Retries stay bounded; unknown stays inconclusive, never complete.
export const AGENT_WORKING_STATUS = "working";
export const AGENT_BLOCKED_STATUS = "blocked";
const AGENT_ERROR_STATUSES = new Set(["error", "failed"]);
export const WAIT_TIMEOUT_CODE = "WAIT_TIMEOUT_EXPIRED";
export const AGENT_BLOCKED_CODE = "AGENT_BLOCKED";
export const AGENT_ERROR_CODE = "AGENT_ERROR";

export function classifyAgentStatus(status) {
  if (SETTLED_STATES.has(status)) {
    return { settled: true, code: null, retryable: false, action: "retrieve" };
  }
  if (status === AGENT_WORKING_STATUS) {
    return { settled: false, code: "AGENT_NOT_SETTLED", retryable: true, action: "continue" };
  }
  if (status === AGENT_BLOCKED_STATUS) {
    return { settled: false, code: AGENT_BLOCKED_CODE, retryable: true, action: "inspect" };
  }
  if (status === undefined || status === null || status === "unknown") {
    return { settled: false, code: "AGENT_NOT_SETTLED", retryable: true, action: "continue", inconclusive: true };
  }
  if (typeof status === "string" && AGENT_ERROR_STATUSES.has(status)) {
    return { settled: false, code: AGENT_ERROR_CODE, retryable: false, action: "report" };
  }
  return { settled: false, code: "AGENT_NOT_SETTLED", retryable: true, action: "continue", inconclusive: true };
}

export function waitTimeoutError(target, timeoutMs) {
  const bound = Number.isSafeInteger(timeoutMs) ? ` within ${timeoutMs} ms safety timeout` : " within the safety timeout";
  return error(
    WAIT_TIMEOUT_CODE,
    `Herdr agent ${target} did not settle${bound}; safety timeout is the final bound only with preserved state, not a retryable working state.`,
    false,
  );
}
const DEFAULT_PAGE_BYTES = 8192;
const MIN_PAGE_BYTES = 1024;
const MAX_PAGE_BYTES = 16384;
const MAX_TOOL_OUTPUT_BYTES = 32768;
const DEFAULT_CURSOR_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_HERDR_OUTPUT_BYTES = 1024 * 1024;

export const ACKNOWLEDGEMENT_REPLIES = new Set(["ACK", "CORRECT", "REPLAN", "STOP"]);
export const MILESTONE_REPLIES = new Set(["CONTINUE", "CORRECT", "REPLAN", "STOP", "FINALIZE"]);
const REPLY_KEYWORD_PATTERN = /^\s*(ACK|CONTINUE|CORRECT|REPLAN|STOP|FINALIZE)\b:?[ \t]*([^\n]*)/;

export function parseWorkerReply(text) {
  if (typeof text !== "string") return null;
  const match = REPLY_KEYWORD_PATTERN.exec(text);
  if (!match) return null;
  const keyword = match[1];
  return {
    keyword,
    detail: match[2].trim(),
    acknowledgement: ACKNOWLEDGEMENT_REPLIES.has(keyword),
    milestone: MILESTONE_REPLIES.has(keyword),
  };
}

function error(code, message, retryable = false) {
  return { ok: false, error: { code, message, retryable } };
}

function processErrorDetail(cause) {
  const value = String(cause?.stderr ?? cause?.message ?? cause).replace(/\s+/g, " ").trim();
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function encodeCursor(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function decodeCursor(cursor, secret, now) {
  if (typeof cursor !== "string" || cursor.length > 4096) {
    return error("INVALID_CURSOR", "The response cursor is malformed.");
  }
  const [encoded, signature, extra] = cursor.split(".");
  if (!encoded || !signature || extra) {
    return error("INVALID_CURSOR", "The response cursor is malformed.");
  }
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return error("INVALID_CURSOR", "The response cursor signature is malformed.");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return error("INVALID_CURSOR", "The response cursor signature is invalid.");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return error("INVALID_CURSOR", "The response cursor payload is invalid.");
  }
  if (
    payload?.v !== 1 ||
    typeof payload.target !== "string" ||
    typeof payload.sessionID !== "string" ||
    typeof payload.messageID !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.digest !== "string" ||
    !Number.isSafeInteger(payload.offset) ||
    payload.offset < 0 ||
    !Number.isSafeInteger(payload.expiresAt)
  ) {
    return error("INVALID_CURSOR", "The response cursor payload is incomplete.");
  }
  if (now() > payload.expiresAt) {
    return error("EXPIRED_CURSOR", "The response cursor has expired. Start retrieval again.");
  }
  return { ok: true, payload };
}

function parseJsonOutput(output, label) {
  const start = output.indexOf("{");
  if (start === -1) throw new Error(`${label} returned no JSON object.`);
  return JSON.parse(output.slice(start));
}

async function defaultRun(command, args, signal, maxBuffer) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
    signal,
  });
  return stdout;
}

function completedText(message) {
  return message?.parts
    ?.filter(
      (part) =>
        part?.type === "text" &&
        typeof part.text === "string" &&
        !part.ignored,
    )
    .map((part) => part.text)
    .join("\n\n");
}

export function selectLatestCompletedResponse(exported) {
  const messages = Array.isArray(exported?.messages) ? exported.messages : [];
  let latestUser;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info?.role === "user") {
      latestUser = messages[index];
      break;
    }
  }
  if (!latestUser) return error("NO_COMPLETED_RESPONSE", "The worker session has no user prompt.", true);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const info = message?.info;
    const text = completedText(message);
    if (
      info?.role === "assistant" &&
      info.parentID === latestUser.info.id &&
      info.time?.completed &&
      !info.error &&
      info.finish !== "tool-calls" &&
      text
    ) {
      return {
        ok: true,
        response: {
          sessionID: info.sessionID,
          messageID: info.id,
          role: info.agent ?? info.mode,
          finish: info.finish ?? "unknown",
          text,
        },
      };
    }
  }
  return error(
    "NO_COMPLETED_RESPONSE",
    "The latest worker turn has no completed final text response. Wait for the worker and retry.",
    true,
  );
}

export function findPinnedResponse(exported, messageID) {
  const message = exported?.messages?.find((candidate) => candidate?.info?.id === messageID);
  const info = message?.info;
  const text = completedText(message);
  if (
    info?.role !== "assistant" ||
    !info.time?.completed ||
    info.error ||
    info.finish === "tool-calls" ||
    !text
  ) {
    return error("MESSAGE_CHANGED", "The pinned worker response is no longer available in completed form.");
  }
  return {
    ok: true,
    response: {
      sessionID: info.sessionID,
      messageID: info.id,
      role: info.agent ?? info.mode,
      finish: info.finish ?? "unknown",
      text,
    },
  };
}

function normalizePageBytes(value) {
  if (value === undefined) return { ok: true, value: DEFAULT_PAGE_BYTES };
  if (!Number.isSafeInteger(value) || value < MIN_PAGE_BYTES || value > MAX_PAGE_BYTES) {
    return error(
      "INVALID_REQUEST",
      `maxBytes must be an integer from ${MIN_PAGE_BYTES} through ${MAX_PAGE_BYTES}.`,
    );
  }
  return { ok: true, value };
}

function utf8PageEnd(buffer, offset, requestedBytes) {
  let end = Math.min(buffer.length, offset + requestedBytes);
  while (end > offset && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

function makePage({ response, target, offset, requestedBytes, secret, expiresAt }) {
  const bytes = Buffer.from(response.text, "utf8");
  if (offset > bytes.length) return error("INVALID_CURSOR", "The response cursor offset exceeds the message length.");
  const digest = sha256(bytes);
  let pageBytes = requestedBytes;

  while (pageBytes >= MIN_PAGE_BYTES) {
    const end = utf8PageEnd(bytes, offset, pageBytes);
    const complete = end === bytes.length;
    const payload = {
      v: 1,
      target,
      sessionID: response.sessionID,
      messageID: response.messageID,
      role: response.role,
      digest,
      offset: end,
      expiresAt,
    };
    const result = {
      ok: true,
      target,
      sessionID: response.sessionID,
      messageID: response.messageID,
      role: response.role,
      finish: response.finish,
      offset,
      nextOffset: end,
      totalBytes: bytes.length,
      complete,
      cursor: complete ? null : encodeCursor(payload, secret),
      reply: offset === 0 ? parseWorkerReply(response.text) : undefined,
      text: bytes.subarray(offset, end).toString("utf8"),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_TOOL_OUTPUT_BYTES) return result;
    pageBytes = Math.floor(pageBytes / 2);
  }
  return error("OUTPUT_BUDGET_EXCEEDED", "A response page could not fit within the tool output budget.");
}

function validateTarget(target) {
  if (typeof target !== "string" || !/^(?:[a-z][a-z0-9_-]{0,31}|w[0-9A-Za-z]+:p[0-9A-Za-z]+)$/.test(target)) {
    return error("INVALID_REQUEST", "target must be a Herdr agent name or pane ID.");
  }
  return { ok: true };
}

async function resolveInitialResponse(target, run, signal, maxExportBytes, allowedRoles) {
  let agent;
  try {
    const output = await run("herdr", ["agent", "get", target], signal, MAX_HERDR_OUTPUT_BYTES);
    agent = parseJsonOutput(output, "herdr agent get").result?.agent;
  } catch (cause) {
    const detail = processErrorDetail(cause);
    if (detail.includes("agent_not_found")) return error("AGENT_NOT_FOUND", `Herdr agent ${target} was not found.`);
    return error("HERDR_UNAVAILABLE", `Unable to query Herdr agent ${target}: ${detail}`, true);
  }
  const waitStatus = agent?.agent_status;
  if (!SETTLED_STATES.has(waitStatus)) {
    const classified = classifyAgentStatus(waitStatus);
    if (classified.code === AGENT_BLOCKED_CODE) {
      return error(
        AGENT_BLOCKED_CODE,
        `Herdr agent ${target} is blocked; inspect with herdr agent get plus herdr agent read then decide under user safety constraints with never blind input.`,
        true,
      );
    }
    if (classified.code === AGENT_ERROR_CODE) {
      return error(
        AGENT_ERROR_CODE,
        `Herdr agent ${target} is ${waitStatus}; explicit error state requires an explicit report with preserved state.`,
        false,
      );
    }
    return error(
      "AGENT_NOT_SETTLED",
      `Herdr agent ${target} is ${waitStatus ?? "unknown"}; wait for idle or done.`,
      true,
    );
  }
  const session = agent.agent_session;
  if (
    session?.agent !== "opencode" ||
    session.kind !== "id" ||
    session.source !== "herdr:opencode" ||
    typeof session.value !== "string"
  ) {
    return error("AGENT_NOT_OPENCODE", `Herdr agent ${target} does not expose a trusted OpenCode session ID.`);
  }
  const exported = await exportSession(session.value, run, signal, maxExportBytes);
  if (!exported.ok) return exported;
  const selected = selectLatestCompletedResponse(exported.value);
  if (!selected.ok) return selected;
  if (selected.response.sessionID !== session.value) {
    return error("SESSION_EXPORT_FAILED", "The exported response belongs to a different OpenCode session.");
  }
  if (!allowedRoles.has(selected.response.role)) {
    return error(
      "UNSUPPORTED_WORKER_ROLE",
      `Herdr target ${target} completed as role ${selected.response.role ?? "unknown"}, which is not retrievable by ${allowedRolesName(allowedRoles)}.`,
    );
  }
  return selected;
}

function allowedRolesName(allowedRoles) {
  for (const [agent, roles] of RESPONSE_MATRIX) {
    if (roles === allowedRoles) return agent;
  }
  return "this caller";
}

async function exportSession(sessionID, run, signal, maxExportBytes) {
  try {
    const output = await run("opencode", ["export", sessionID], signal, maxExportBytes);
    return { ok: true, value: parseJsonOutput(output, "opencode export") };
  } catch (cause) {
    const detail = processErrorDetail(cause);
    const code =
      cause?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? "SESSION_EXPORT_TOO_LARGE"
        : detail.toLowerCase().includes("not found")
          ? "SESSION_NOT_FOUND"
          : "SESSION_EXPORT_FAILED";
    return error(code, `Unable to export OpenCode session ${sessionID}: ${detail}`, code === "SESSION_EXPORT_FAILED");
  }
}

export function createResponseService(options = {}) {
  const run = options.run ?? defaultRun;
  const secret = options.secret ?? randomBytes(32);
  const now = options.now ?? Date.now;
  const cursorTtlMs = options.cursorTtlMs ?? DEFAULT_CURSOR_TTL_MS;
  const maxExportBytes = options.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES;

  if (!Number.isSafeInteger(maxExportBytes) || maxExportBytes < 1024 * 1024) {
    throw new TypeError("maxExportBytes must be an integer of at least 1048576 bytes.");
  }

  return async function retrieve(args, context) {
    const allowedRoles = RESPONSE_MATRIX.get(context?.agent);
    if (!allowedRoles) {
      return error("UNAUTHORIZED_AGENT", `Agent ${context?.agent ?? "unknown"} may not retrieve worker responses.`);
    }
    const pageSize = normalizePageBytes(args.maxBytes);
    if (!pageSize.ok) return pageSize;
    if (Boolean(args.target) === Boolean(args.cursor)) {
      return error("INVALID_REQUEST", "Provide exactly one of target or cursor.");
    }

    if (args.target) {
      const valid = validateTarget(args.target);
      if (!valid.ok) return valid;
      const selected = await resolveInitialResponse(args.target, run, context.abort, maxExportBytes, allowedRoles);
      if (!selected.ok) return selected;
      return makePage({
        response: selected.response,
        target: args.target,
        offset: 0,
        requestedBytes: pageSize.value,
        secret,
        expiresAt: now() + cursorTtlMs,
      });
    }

    const decoded = decodeCursor(args.cursor, secret, now);
    if (!decoded.ok) return decoded;
    const exported = await exportSession(decoded.payload.sessionID, run, context.abort, maxExportBytes);
    if (!exported.ok) return exported;
    const pinned = findPinnedResponse(exported.value, decoded.payload.messageID);
    if (!pinned.ok) return pinned;
    if (
      pinned.response.sessionID !== decoded.payload.sessionID ||
      pinned.response.role !== decoded.payload.role ||
      !allowedRoles.has(pinned.response.role) ||
      sha256(Buffer.from(pinned.response.text, "utf8")) !== decoded.payload.digest
    ) {
      return error("MESSAGE_CHANGED", "The pinned worker response changed after pagination began.");
    }
    return makePage({
      response: pinned.response,
      target: decoded.payload.target,
      offset: decoded.payload.offset,
      requestedBytes: pageSize.value,
      secret,
      expiresAt: decoded.payload.expiresAt,
    });
  };
}

export function createResponseTool(options = {}) {
  const retrieve = createResponseService(options);
  return tool({
    description:
      "Retrieve the complete final response from a settled Herdr-managed OpenCode worker. Start with target, then follow each returned cursor until complete is true.",
    args: {
      target: tool.schema.string().optional().describe("Herdr agent name or pane ID for the initial page."),
      cursor: tool.schema.string().optional().describe("Opaque cursor returned by the preceding page."),
      maxBytes: tool.schema
        .number()
        .int()
        .min(MIN_PAGE_BYTES)
        .max(MAX_PAGE_BYTES)
        .optional()
        .describe("Maximum UTF-8 response bytes requested for this page."),
    },
    async execute(args, context) {
      const result = await retrieve(args, context);
      context.metadata({
        title: result.ok ? `Worker response: ${result.target}` : `Worker response: ${result.error.code}`,
        metadata: result.ok
          ? { sessionID: result.sessionID, messageID: result.messageID, complete: result.complete }
          : { error: result.error.code },
      });
      return JSON.stringify(result);
    },
  });
}
