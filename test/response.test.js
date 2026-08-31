import test from "node:test";
import assert from "node:assert/strict";

import {
  createResponseService,
  findPinnedResponse,
  selectLatestCompletedResponse,
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
  role = "sheep-plan",
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

function exported(messages, role = "sheep-plan") {
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

const context = { agent: "shepherd-plan", abort: new AbortController().signal };

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
  let result = await retrieve({ target: "worker_1", maxBytes: 1024 }, context);
  while (true) {
    assert.equal(result.ok, true);
    pages.push(result.text);
    if (result.complete) break;
    result = await retrieve({ cursor: result.cursor, maxBytes: 1024 }, context);
  }
  assert.equal(pages.join(""), text);
  assert.equal(result.nextOffset, Buffer.byteLength(text, "utf8"));
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
    secret: Buffer.alloc(32, 2),
  });
  const first = await retrieve({ target: "worker_1", maxBytes: 1024 }, context);
  const second = await retrieve({ cursor: first.cursor, maxBytes: 1024 }, context);
  assert.equal(second.ok, true);
  assert.equal(herdrCalls, 1);
});

test("rejects unauthorized callers, active workers, invalid targets, and cursor tampering", async () => {
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text: "x".repeat(3000) })]);
  const retrieve = createResponseService({ run: runner(() => fixture), secret: Buffer.alloc(32, 3) });
  assert.equal(
    (await retrieve({ target: "worker_1" }, { ...context, agent: "sheep-build" })).error.code,
    "UNAUTHORIZED_AGENT",
  );
  assert.equal((await retrieve({ target: "bad target" }, context)).error.code, "INVALID_REQUEST");

  const active = createResponseService({ run: runner(() => fixture, "working"), secret: Buffer.alloc(32, 3) });
  assert.equal((await active({ target: "worker_1" }, context)).error.code, "AGENT_NOT_SETTLED");

  const first = await retrieve({ target: "worker_1", maxBytes: 1024 }, context);
  const tampered = `${first.cursor.slice(0, -1)}${first.cursor.endsWith("a") ? "b" : "a"}`;
  assert.equal((await retrieve({ cursor: tampered }, context)).error.code, "INVALID_CURSOR");
});

test("rejects expired cursors and changed pinned messages", async () => {
  let currentText = "a".repeat(3000);
  let currentTime = 1000;
  const getExport = () =>
    exported([user("u1"), assistant({ id: "final", parentID: "u1", text: currentText })]);
  const retrieve = createResponseService({
    run: runner(getExport),
    secret: Buffer.alloc(32, 4),
    now: () => currentTime,
    cursorTtlMs: 100,
  });
  const first = await retrieve({ target: "worker_1", maxBytes: 1024 }, context);
  currentText = `changed${currentText}`;
  assert.equal((await retrieve({ cursor: first.cursor }, context)).error.code, "MESSAGE_CHANGED");

  currentText = "a".repeat(3000);
  const fresh = await retrieve({ target: "worker_1", maxBytes: 1024 }, context);
  currentTime = 1200;
  assert.equal((await retrieve({ cursor: fresh.cursor }, context)).error.code, "EXPIRED_CURSOR");
});

test("supports concurrent independent reads of the same worker", async () => {
  const text = "concurrent".repeat(1000);
  const fixture = exported([user("u1"), assistant({ id: "final", parentID: "u1", text })]);
  const retrieve = createResponseService({ run: runner(() => fixture), secret: Buffer.alloc(32, 5) });

  async function allPages() {
    let page = await retrieve({ target: "worker_1", maxBytes: 1024 }, context);
    let output = "";
    while (page.ok) {
      output += page.text;
      if (page.complete) return output;
      page = await retrieve({ cursor: page.cursor, maxBytes: 1024 }, context);
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
    secret: Buffer.alloc(32, 6),
  });
  const result = await retrieve({ target: "worker_1" }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["herdr", ["agent", "get", "worker_1"]]);
});
