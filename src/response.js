import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const ALLOWED_CALLERS = new Set(["shepherd-plan", "shepherd-build"]);
const ALLOWED_TARGET_ROLES = new Set([
  "sheep-plan",
  "sheep-build",
  "shearer-review-low",
  "shearer-review-medium",
]);
const SETTLED_STATES = new Set(["idle", "done"]);
const DEFAULT_PAGE_BYTES = 8192;
const MIN_PAGE_BYTES = 1024;
const MAX_PAGE_BYTES = 16384;
const MAX_TOOL_OUTPUT_BYTES = 32768;
const DEFAULT_CURSOR_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PROCESS_BUFFER = 256 * 1024 * 1024;

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

async function defaultRun(command, args, signal) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_PROCESS_BUFFER,
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

async function resolveInitialResponse(target, run, signal) {
  let agent;
  try {
    const output = await run("herdr", ["agent", "get", target], signal);
    agent = parseJsonOutput(output, "herdr agent get").result?.agent;
  } catch (cause) {
    const detail = processErrorDetail(cause);
    if (detail.includes("agent_not_found")) return error("AGENT_NOT_FOUND", `Herdr agent ${target} was not found.`);
    return error("HERDR_UNAVAILABLE", `Unable to query Herdr agent ${target}: ${detail}`, true);
  }
  if (!SETTLED_STATES.has(agent?.agent_status)) {
    return error(
      "AGENT_NOT_SETTLED",
      `Herdr agent ${target} is ${agent?.agent_status ?? "unknown"}; wait for idle or done.`,
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
  const exported = await exportSession(session.value, run, signal);
  if (!exported.ok) return exported;
  const selected = selectLatestCompletedResponse(exported.value);
  if (!selected.ok) return selected;
  if (selected.response.sessionID !== session.value) {
    return error("SESSION_EXPORT_FAILED", "The exported response belongs to a different OpenCode session.");
  }
  if (!ALLOWED_TARGET_ROLES.has(selected.response.role)) {
    return error(
      "UNSUPPORTED_WORKER_ROLE",
      `Herdr target ${target} completed as unsupported agent role ${selected.response.role ?? "unknown"}.`,
    );
  }
  return selected;
}

async function exportSession(sessionID, run, signal) {
  try {
    const output = await run("opencode", ["export", sessionID], signal);
    return { ok: true, value: parseJsonOutput(output, "opencode export") };
  } catch (cause) {
    const detail = processErrorDetail(cause);
    const code = detail.toLowerCase().includes("not found") ? "SESSION_NOT_FOUND" : "SESSION_EXPORT_FAILED";
    return error(code, `Unable to export OpenCode session ${sessionID}: ${detail}`, code === "SESSION_EXPORT_FAILED");
  }
}

export function createResponseService(options = {}) {
  const run = options.run ?? defaultRun;
  const secret = options.secret ?? randomBytes(32);
  const now = options.now ?? Date.now;
  const cursorTtlMs = options.cursorTtlMs ?? DEFAULT_CURSOR_TTL_MS;

  return async function retrieve(args, context) {
    if (!ALLOWED_CALLERS.has(context?.agent)) {
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
      const selected = await resolveInitialResponse(args.target, run, context.abort);
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
    const exported = await exportSession(decoded.payload.sessionID, run, context.abort);
    if (!exported.ok) return exported;
    const pinned = findPinnedResponse(exported.value, decoded.payload.messageID);
    if (!pinned.ok) return pinned;
    if (
      pinned.response.sessionID !== decoded.payload.sessionID ||
      pinned.response.role !== decoded.payload.role ||
      !ALLOWED_TARGET_ROLES.has(pinned.response.role) ||
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
