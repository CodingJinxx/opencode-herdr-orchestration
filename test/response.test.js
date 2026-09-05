import test from "node:test";
import assert from "node:assert/strict";

import {
  ACKNOWLEDGEMENT_REPLIES,
  AGENT_BLOCKED_CODE,
  AGENT_ERROR_CODE,
  MILESTONE_REPLIES,
  RESPONSE_MATRIX,
  WAIT_TIMEOUT_CODE,
  classifyAgentStatus,
  createResponseService,
  findPinnedResponse,
  parseWorkerReply,
  selectLatestCompletedResponse,
  waitTimeoutError,
} from "../src/response.js";

function user(id, created = 1) {
  return { info: { id, sessionID: "ses_worker", role: "user", time: { created } }, parts: [] };
}

function assistant({
  id,
  parentID,
  text,
  finish = "stop",
  completed = 2,
  role = "grazer",
  error,
  ignored = false,
}) {
  return {
    info: {
      id,
      sessionID: "ses_worker",
      role: "assistant",
      parentID,
      agent: role,
      mode: role,
      finish,
      error,
      time: { created: 1, ...(completed ? { completed } : {}) },
    },
    parts: text === undefined ? [] : [{ type: "text", text, ignored }],
  };
}

function exported(messages, role = "grazer") {
  return { info: { id: "ses_worker", agent: role }, messages };
}

function herdrAgent(status = "done") {
  return JSON.stringify({
    result: {
      agent: {
        agent_status: status,
        agent_session: {
          agent: "opencode",
          kind: "id",
          source: "herdr:opencode",
          value: "ses_worker",
        },
      },
    },
  });
}

function runner(getExport, status = "done") {
  return async (command, args) => {
    if (command === "herdr") {
      assert.deepEqual(args, ["agent", "get", "worker_1"]);
      return herdrAgent(status);
    }
    if (command === "opencode") {
      assert.deepEqual(args, ["export", "ses_worker"]);
      return `Exporting session: ses_worker\n${JSON.stringify(getExport())}`;
    }
    throw new Error(`Unexpected command ${command}`);
  };
}

const abort = new AbortController().signal;
const contextFor = (agent) => ({ agent, abort });

test("defines the approved response retrieval matrix", () => {
  assert.deepEqual(
    [...RESPONSE_MATRIX.entries()],
    [
      ["shepherd", new Set(["grazer"])],
      ["shepherd-governor", new Set(["grazer", "sheepdog"])],
      ["sheepdog", new Set(["grazer", "sheep", "shearer-low", "shearer-medium"])],
    ],
  );
});

test("classifies acknowledgement and post-milestone reply keywords", () => {
  assert.deepEqual(ACKNOWLEDGEMENT_REPLIES, new Set(["ACK", "CORRECT", "REPLAN", "STOP"]));
  assert.deepEqual(MILESTONE_REPLIES, new Set(["CONTINUE", "CORRECT", "REPLAN", "STOP", "FINALIZE"]));

  assert.equal(parseWorkerReply("ACK\nstarting now").keyword, "ACK");
  assert.equal(parseWorkerReply("ACK\nstarting now").acknowledgement, true);
  assert.equal(parseWorkerReply("ACK\nstarting now").milestone, false);

  assert.equal(parseWorkerReply("FINALIZE: task done").keyword, "FINALIZE");
  assert.equal(parseWorkerReply("FINALIZE: task done").milestone, true);
  assert.equal(parseWorkerReply("FINALIZE: task done").acknowledgement, false);
  assert.equal(parseWorkerReply("FINALIZE: task done").detail, "task done");

  for (const keyword of ["CORRECT", "REPLAN", "STOP"]) {
    const reply = parseWorkerReply(`${keyword}\ndetail`);
    assert.equal(reply.acknowledgement, true);
    assert.equal(reply.milestone, true);
  }

  assert.equal(parseWorkerReply("CONTINUE\nready").milestone, true);
  assert.equal(parseWorkerReply("CONTINUE\nready").acknowledgement, false);
});

test("returns null for responses without a leading reply keyword", () => {
  assert.equal(parseWorkerReply("The task is complete.\nACK later"), null);
  assert.equal(parseWorkerReply(""), null);
  assert.equal(parseWorkerReply(undefined), null);
  assert.equal(parseWorkerReply(null), null);
  assert.equal(parseWorkerReply("  \nSTOP\nblocked").keyword, "STOP");
});

test("selects only the latest turn's completed final response", () => {
  const result = selectLatestCompletedResponse(
    exported([
      user("u1"),
      assistant({ id: "old", parentID: "u1", text: "old" }),
      user("u2", 3),
      assistant({ id: "step", parentID: "u2", text: "working", finish: "tool-calls" }),
      assistant({ id: "aborted", parentID: "u2", text: "bad", error: { name: "Aborted" } }),
      assistant({ id: "final", parentID: "u2", text: "complete" }),
    ]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.response.messageID, "final");
  assert.equal(result.response.text, "complete");
});

test("ignores ignored text parts and rejects incomplete latest turns", () => {
  const ignored = assistant({ id: "final", parentID: "u1", text: "hidden" });
  ignored.parts.push({ type: "text", text: "visible" });
  ignored.parts[0].ignored = true;
  assert.equal(selectLatestCompletedResponse(exported([user("u1"), ignored])).response.text, "visible");

  const missing = selectLatestCompletedResponse(
    exported([user("u1"), assistant({ id: "step", parentID: "u1", text: "partial", finish: "tool-calls" })]),
  );
  assert.equal(missing.error.code, "NO_COMPLETED_RESPONSE");
  assert.equal(missing.error.retryable, true);
});

test("finds a pinned response after a newer worker turn", () => {
  const fixture = exported([
    user("u1"),
    assistant({ id: "first", parentID: "u1", text: "first response" }),
    user("u2"),
    assistant({ id: "second", parentID: "u2", text: "second response" }),
  ]);
  assert.equal(findPinnedResponse(fixture, "first").response.text, "first response");
});

test("paginates without splitting UTF-8 and reconstructs exact text", async () => {
  const text = `${"a".repeat(1022)}🙂${"界".repeat(900)}`;
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text })]);
  const retrieve = createResponseService({
    run: runner(() => fixture),
    secret: Buffer.alloc(32, 1),
    now: () => 1000,
  });

  const pages = [];
  let result = await retrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("shepherd"));
  while (true) {
    assert.equal(result.ok, true);
    pages.push(result.text);
    if (result.complete) break;
    result = await retrieve({ cursor: result.cursor, maxBytes: 1024 }, contextFor("shepherd"));
  }
  assert.equal(pages.join(""), text);
  assert.equal(result.nextOffset, Buffer.byteLength(text, "utf8"));
});

test("carries the reply keyword on the first page and not on continuation pages", async () => {
  const text = `ACK\n${"x".repeat(3000)}`;
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text })]);
  const retrieve = createResponseService({
    run: runner(() => fixture),
    secret: Buffer.alloc(32, 2),
  });
  const first = await retrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("shepherd"));
  assert.equal(first.reply.keyword, "ACK");
  assert.equal(first.reply.acknowledgement, true);
  const second = await retrieve({ cursor: first.cursor, maxBytes: 1024 }, contextFor("shepherd"));
  assert.equal(second.ok, true);
  assert.equal(second.reply, undefined);
});

test("enforces the caller-to-target retrieval matrix", async () => {
  const fixtureFor = (role) => exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "done", role })], role);
  const retrieve = createResponseService({ run: runner(() => fixtureFor("sheep")), secret: Buffer.alloc(32, 3) });

  // Leaves may not retrieve at all.
  for (const agent of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    const result = await retrieve({ target: "worker_1" }, contextFor(agent));
    assert.equal(result.error.code, "UNAUTHORIZED_AGENT", `${agent} must not retrieve responses`);
  }

  // Shepherd may retrieve only grazer.
  assert.equal(
    (await retrieve({ target: "worker_1" }, contextFor("shepherd"))).error.code,
    "UNSUPPORTED_WORKER_ROLE",
    "shepherd must not retrieve sheep",
  );

  // Governor may retrieve grazer and sheepdog but not sheep.
  const governorRetrieve = createResponseService({
    run: runner(() => fixtureFor("grazer")),
    secret: Buffer.alloc(32, 3),
  });
  assert.equal((await governorRetrieve({ target: "worker_1" }, contextFor("shepherd-governor"))).ok, true);
  const sheepFixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "done", role: "sheep" })], "sheep");
  const governorBlocked = createResponseService({
    run: runner(() => sheepFixture),
    secret: Buffer.alloc(32, 3),
  });
  assert.equal(
    (await governorBlocked({ target: "worker_1" }, contextFor("shepherd-governor"))).error.code,
    "UNSUPPORTED_WORKER_ROLE",
    "governor must not retrieve sheep",
  );

  // Sheepdog may retrieve sheep, shearers, and grazer but not the governor.
  const dogRetrieve = createResponseService({
    run: runner(() => fixtureFor("shearer-medium")),
    secret: Buffer.alloc(32, 3),
  });
  assert.equal((await dogRetrieve({ target: "worker_1" }, contextFor("sheepdog"))).ok, true);
  const governorFixture = exported(
    [user("u1"), assistant({ id: "final", parentID: "u1", text: "done", role: "shepherd-governor" })],
    "shepherd-governor",
  );
  const dogBlocked = createResponseService({ run: runner(() => governorFixture), secret: Buffer.alloc(32, 3) });
  assert.equal(
    (await dogBlocked({ target: "worker_1" }, contextFor("sheepdog"))).error.code,
    "UNSUPPORTED_WORKER_ROLE",
    "sheepdog must not retrieve the governor",
  );
});

test("continuation pages stay within the caller's matrix targets", async () => {
  // Sheepdog pins a sheep response; a continuation must remain valid for sheepdog.
  const sheepFixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "x".repeat(3000), role: "sheep" })], "sheep");
  const retrieve = createResponseService({ run: runner(() => sheepFixture), secret: Buffer.alloc(32, 4) });
  const first = await retrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("sheepdog"));
  assert.equal(first.ok, true);
  const second = await retrieve({ cursor: first.cursor, maxBytes: 1024 }, contextFor("sheepdog"));
  assert.equal(second.ok, true);

  // The same pinned sheep response is out of matrix for the shepherd.
  const shepherdRetrieve = createResponseService({
    run: runner(() => sheepFixture),
    secret: Buffer.alloc(32, 4),
  });
  const pinned = await shepherdRetrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("sheepdog"));
  assert.equal(
    (await shepherdRetrieve({ cursor: pinned.cursor, maxBytes: 1024 }, contextFor("shepherd"))).error.code,
    "MESSAGE_CHANGED",
    "shepherd must not continue a sheepdog pin outside its matrix",
  );
});

test("continuation does not require the Herdr target to remain live", async () => {
  const text = "x".repeat(3000);
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text })]);
  let herdrCalls = 0;
  const base = runner(() => fixture);
  const retrieve = createResponseService({
    run: async (command, args, signal) => {
      if (command === "herdr") herdrCalls += 1;
      return base(command, args, signal);
    },
    secret: Buffer.alloc(32, 5),
  });
  const first = await retrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("shepherd"));
  const second = await retrieve({ cursor: first.cursor, maxBytes: 1024 }, contextFor("shepherd"));
  assert.equal(second.ok, true);
  assert.equal(herdrCalls, 1);
});

test("rejects active workers, invalid targets, and cursor tampering", async () => {
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "x".repeat(3000) })]);
  const retrieve = createResponseService({ run: runner(() => fixture), secret: Buffer.alloc(32, 6) });
  assert.equal((await retrieve({ target: "bad target" }, contextFor("shepherd"))).error.code, "INVALID_REQUEST");

  const active = createResponseService({ run: runner(() => fixture, "working"), secret: Buffer.alloc(32, 6) });
  assert.equal((await active({ target: "worker_1" }, contextFor("shepherd"))).error.code, "AGENT_NOT_SETTLED");

  const first = await retrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("shepherd"));
  const [payload, signature] = first.cursor.split(".");
  const tampered = `${payload.startsWith("a") ? "b" : "a"}${payload.slice(1)}.${signature}`;
  assert.equal((await retrieve({ cursor: tampered }, contextFor("shepherd"))).error.code, "INVALID_CURSOR");
});

test("rejects expired cursors and changed pinned messages", async () => {
  let currentText = "a".repeat(3000);
  let currentTime = 1000;
  const getExport = () =>
    exported([user("u1"), assistant({ id: "final", parentID: "u1", text: currentText })]);
  const retrieve = createResponseService({
    run: runner(getExport),
    secret: Buffer.alloc(32, 7),
    now: () => currentTime,
    cursorTtlMs: 100,
  });
  const first = await retrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("shepherd"));
  currentText = `changed${currentText}`;
  assert.equal((await retrieve({ cursor: first.cursor }, contextFor("shepherd"))).error.code, "MESSAGE_CHANGED");

  currentText = "a".repeat(3000);
  const fresh = await retrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("shepherd"));
  currentTime = 1200;
  assert.equal((await retrieve({ cursor: fresh.cursor }, contextFor("shepherd"))).error.code, "EXPIRED_CURSOR");
});

test("supports concurrent independent reads of the same worker", async () => {
  const text = "concurrent".repeat(1000);
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text })]);
  const retrieve = createResponseService({ run: runner(() => fixture), secret: Buffer.alloc(32, 8) });

  async function allPages() {
    let page = await retrieve({ target: "worker_1", maxBytes: 1024 }, contextFor("shepherd"));
    let output = "";
    while (page.ok) {
      output += page.text;
      if (page.complete) return output;
      page = await retrieve({ cursor: page.cursor, maxBytes: 1024 }, contextFor("shepherd"));
    }
    throw new Error(page.error.code);
  }

  const [left, right] = await Promise.all([allPages(), allPages()]);
  assert.equal(left, text);
  assert.equal(right, text);
});

test("uses argv execution rather than interpolating target text", async () => {
  const calls = [];
  const retrieve = createResponseService({
    run: async (command, args) => {
      calls.push([command, args]);
      if (command === "herdr") return herdrAgent();
      return JSON.stringify(exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "done" })]));
    },
    secret: Buffer.alloc(32, 9),
  });
  const result = await retrieve({ target: "worker_1" }, contextFor("shepherd"));
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["herdr", ["agent", "get", "worker_1"]]);
});

test("returns a specific error when a session export exceeds the configured limit", async () => {
  const failure = Object.assign(new Error("stdout maxBuffer length exceeded"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  });
  const retrieve = createResponseService({
    run: async (command) => {
      if (command === "herdr") return herdrAgent();
      throw failure;
    },
    secret: Buffer.alloc(32, 10),
    maxExportBytes: 1024 * 1024,
  });
  const result = await retrieve({ target: "worker_1" }, contextFor("shepherd"));
  assert.equal(result.error.code, "SESSION_EXPORT_TOO_LARGE");
  assert.equal(result.error.retryable, false);
});

test("21-M1 sheepdog retrieves each owned role and denies the governor", async () => {
  for (const role of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: `${role} done`, role })], role);
    const retrieve = createResponseService({ run: runner(() => fixture), secret: Buffer.alloc(32, 11) });
    const result = await retrieve({ target: "worker_1" }, contextFor("sheepdog"));
    assert.equal(result.ok, true, `sheepdog must retrieve ${role}`);
    assert.equal(result.text, `${role} done`);
  }
  const governorFixture = exported(
    [user("u1"), assistant({ id: "final", parentID: "u1", text: "gov done", role: "shepherd-governor" })],
    "shepherd-governor",
  );
  const dogBlocked = createResponseService({ run: runner(() => governorFixture), secret: Buffer.alloc(32, 11) });
  assert.equal(
    (await dogBlocked({ target: "worker_1" }, contextFor("sheepdog"))).error.code,
    "UNSUPPORTED_WORKER_ROLE",
    "sheepdog must not retrieve the governor",
  );
});

// --- 20-M1 responsive wait failure taxonomy ----------------------------------

test("20-M1 settlement via idle or done retrieves through the authoritative channel", async () => {
  for (const status of ["idle", "done"]) {
    const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "settled done" })]);
    const retrieve = createResponseService({ run: runner(() => fixture, status), secret: Buffer.alloc(32, 20) });
    const result = await retrieve({ target: "worker_1" }, contextFor("shepherd"));
    assert.equal(result.ok, true, `${status} must settle`);
    assert.equal(result.text, "settled done");
  }
});

test("20-M1 working stays AGENT_NOT_SETTLED with bounded retry", async () => {
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "x" })]);
  const retrieve = createResponseService({ run: runner(() => fixture, "working"), secret: Buffer.alloc(32, 21) });
  const result = await retrieve({ target: "worker_1" }, contextFor("shepherd"));
  assert.equal(result.error.code, "AGENT_NOT_SETTLED");
  assert.equal(result.error.retryable, true);
  assert.match(result.error.message, /working/);
  const classified = classifyAgentStatus("working");
  assert.equal(classified.code, "AGENT_NOT_SETTLED");
  assert.equal(classified.action, "continue");
});

test("20-M1 early command failure stays distinct from safety timeout", async () => {
  const failing = createResponseService({
    run: async (command) => {
      if (command === "herdr") throw Object.assign(new Error("herdr agent get: connection refused"), { stderr: "connection refused" });
      throw new Error("unexpected");
    },
    secret: Buffer.alloc(32, 22),
  });
  const early = await failing({ target: "worker_1" }, contextFor("shepherd"));
  assert.equal(early.error.code, "HERDR_UNAVAILABLE");
  assert.equal(early.error.retryable, true);
  const timeout = waitTimeoutError("worker_1", 60000);
  assert.equal(timeout.error.code, WAIT_TIMEOUT_CODE);
  assert.equal(timeout.error.code, "WAIT_TIMEOUT_EXPIRED");
  assert.equal(timeout.error.retryable, false);
  assert.notEqual(early.error.code, timeout.error.code, "early failure must not decay to timeout");
  assert.match(timeout.error.message, /final bound/);
});

test("20-M1 disappearance gets an explicit AGENT_NOT_FOUND report", async () => {
  const missing = createResponseService({
    run: async (command) => {
      if (command === "herdr") throw Object.assign(new Error("agent_not_found: worker_1"), { stderr: "agent_not_found" });
      throw new Error("unexpected");
    },
    secret: Buffer.alloc(32, 23),
  });
  const result = await missing({ target: "worker_1" }, contextFor("shepherd"));
  assert.equal(result.error.code, "AGENT_NOT_FOUND");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /was not found/);
});

test("20-M1 evidenced explicit error state stays distinct from working", async () => {
  for (const status of ["error", "failed"]) {
    const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "x" })]);
    const retrieve = createResponseService({ run: runner(() => fixture, status), secret: Buffer.alloc(32, 24) });
    const result = await retrieve({ target: "worker_1" }, contextFor("shepherd"));
    assert.equal(result.error.code, AGENT_ERROR_CODE, `${status} must be explicit error`);
    assert.equal(result.error.retryable, false);
    assert.match(result.error.message, /explicit error state/);
  }
  const blockedFixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "x" })]);
  const blockedRetrieve = createResponseService({ run: runner(() => blockedFixture, "blocked"), secret: Buffer.alloc(32, 24) });
  const blocked = await blockedRetrieve({ target: "worker_1" }, contextFor("shepherd"));
  assert.equal(blocked.error.code, AGENT_BLOCKED_CODE);
  assert.equal(blocked.error.retryable, true);
  assert.match(blocked.error.message, /never blind input/);
});

test("20-M1 safety timeout expiry helper is distinct and final", () => {
  const timeout = waitTimeoutError("worker_1", 120000);
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error.code, "WAIT_TIMEOUT_EXPIRED");
  assert.equal(timeout.error.retryable, false);
  assert.match(timeout.error.message, /safety timeout is the final bound only/);
  const classifiedWorking = classifyAgentStatus("working");
  assert.notEqual(classifiedWorking.code, timeout.error.code);
});

test("20-M1 unknown stays inconclusive, never complete", async () => {
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "x" })]);
  for (const status of [undefined, "unknown"]) {
    const agentPayload = status === undefined ? { agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: "ses_worker" } } : undefined;
    const run = async (command) => {
      if (command === "herdr") {
        if (status === undefined) return JSON.stringify({ result: { agent: agentPayload } });
        return herdrAgent(status);
      }
      return `Exporting session: ses_worker\n${JSON.stringify(fixture)}`;
    };
    const retrieve = createResponseService({ run, secret: Buffer.alloc(32, 25) });
    const result = await retrieve({ target: "worker_1" }, contextFor("shepherd"));
    assert.equal(result.error.code, "AGENT_NOT_SETTLED", `unknown (${String(status)}) stays inconclusive`);
    assert.equal(result.error.retryable, true);
    assert.equal(result.ok, false, "unknown must never read as complete");
  }
  for (const status of ["working", "blocked", "error", "unknown", undefined]) {
    const classified = classifyAgentStatus(status ?? "unknown");
    assert.equal(classified.settled, false, `${String(status)} never settles`);
  }
  assert.equal(classifyAgentStatus("idle").settled, true);
  assert.equal(classifyAgentStatus("done").settled, true);
});
