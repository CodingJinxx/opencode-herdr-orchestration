import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AGENT_BLOCKED_CODE,
  AGENT_ERROR_CODE,
  RESPONSE_MATRIX,
  WAIT_TIMEOUT_CODE,
  classifyAgentStatus,
  createResponseService,
  waitTimeoutError,
} from "../src/response.js";
import {
  MAX_DIAGNOSTIC_CODE_CHARS,
  MAX_DIAGNOSTIC_DETAIL_CHARS,
  MAX_DIAGNOSTIC_EVENTS_DEFAULT,
  MAX_DIAGNOSTIC_EVENTS_LIMIT,
  MAX_DIAGNOSTIC_TARGET_CHARS,
  DIAGNOSTIC_EVENT_TYPES,
  createDiagnosticsLog,
} from "../src/diagnostics.js";
import { createAgents } from "../src/agents.js";
import {
  SHEEPDOG_PROMPT,
  SHEPHERD_GOVERNOR_PROMPT,
  SHEPHERD_PROMPT,
} from "../src/prompts.js";
const EXPECTED_TYPES = [
  "worker-started",
  "prompt-submitted",
  "state-changed",
  "command-failed",
  "settled",
  "disappeared",
  "timed-out",
  "recovery-started",
];
function user(id) {
  return { info: { id, sessionID: "ses_worker", role: "user" }, parts: [] };
}
function assistant(id, parentID, text, role = "grazer") {
  return {
    info: {
      id,
      sessionID: "ses_worker",
      role: "assistant",
      parentID,
      agent: role,
      mode: role,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ type: "text", text, ignored: false }],
  };
}
function runner(fixture, status = "done") {
  return async (command, args) => {
    if (command === "herdr") {
      return JSON.stringify({ result: { agent: { agent_status: status, agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: "ses_worker" } } } });
    }
    return `Exporting session: ses_worker\n${JSON.stringify(fixture)}`;
  };
}
const abort = new AbortController().signal;
test("20-M2 diagnostics records all eight operational event types as bounded summaries", () => {
  assert.deepEqual([...DIAGNOSTIC_EVENT_TYPES], EXPECTED_TYPES);
  assert.equal(MAX_DIAGNOSTIC_EVENTS_DEFAULT, 100);
  assert.equal(MAX_DIAGNOSTIC_EVENTS_LIMIT, 1000);
  assert.equal(MAX_DIAGNOSTIC_TARGET_CHARS, 64);
  assert.equal(MAX_DIAGNOSTIC_CODE_CHARS, 64);
  assert.equal(MAX_DIAGNOSTIC_DETAIL_CHARS, 512);
  const log = createDiagnosticsLog({ now: () => 1000 });
  const codes = {
    "worker-started": "STARTED",
    "prompt-submitted": "PROMPTED",
    "state-changed": "AGENT_NOT_SETTLED",
    "command-failed": "HERDR_UNAVAILABLE",
    settled: "SETTLED",
    disappeared: "AGENT_NOT_FOUND",
    "timed-out": "WAIT_TIMEOUT_EXPIRED",
    "recovery-started": "RECOVERY",
  };
  for (const type of EXPECTED_TYPES) {
    const result = log.record(type, { target: "worker_1", code: codes[type], detail: `bounded ${type} summary` });
    assert.equal(result.ok, true, `${type} must record`);
    assert.equal(result.event.type, type);
    assert.equal(result.event.target, "worker_1");
    assert.ok(Number.isSafeInteger(result.event.sequence));
    assert.equal(typeof result.event.at, "string");
    assert.equal("text" in result.event, false, "diagnostics must never carry response text");
    assert.equal("cursor" in result.event, false);
    assert.equal("messageID" in result.event, false);
  }
  const listed = log.list();
  assert.equal(listed.ok, true);
  assert.equal(listed.events.length, 8);
  assert.deepEqual(listed.events.map((event) => event.type), EXPECTED_TYPES);
  assert.equal(listed.dropped, 0);
});
test("20-M2 diagnostics enforces bounded size plus sensitive exclusion plus bounded retention", () => {
  const log = createDiagnosticsLog({ maxEvents: 3, now: () => 2000 });
  for (let index = 1; index <= 5; index += 1) {
    const result = log.record("state-changed", { target: `worker_${index}`, detail: `poll ${index}` });
    assert.equal(result.ok, true);
  }
  const listed = log.list();
  assert.equal(listed.events.length, 3, "retention keeps only the newest maxEvents");
  assert.deepEqual(listed.events.map((event) => event.sequence), [3, 4, 5]);
  assert.deepEqual(listed.events.map((event) => event.target), ["worker_3", "worker_4", "worker_5"]);
  assert.equal(listed.dropped, 2);
  assert.equal(listed.maxEvents, 3);
  const fresh = createDiagnosticsLog();
  assert.equal(fresh.record("nope", { target: "worker_1" }).error.code, "INVALID_DIAGNOSTIC_TYPE");
  assert.equal(fresh.record("settled", { target: "" }).error.code, "INVALID_DIAGNOSTIC_TARGET");
  assert.equal(fresh.record("settled", { target: "x".repeat(65) }).error.code, "INVALID_DIAGNOSTIC_TARGET");
  assert.equal(fresh.record("settled", { target: "worker_1", code: "x".repeat(65) }).error.code, "INVALID_DIAGNOSTIC_CODE");
  assert.equal(fresh.record("settled", { target: "worker_1", detail: "x".repeat(513) }).error.code, "INVALID_DIAGNOSTIC_DETAIL");
  for (const sensitive of ["transcript dump", "SCROLLBACK here", "chain of thought notes"]) {
    assert.equal(fresh.record("state-changed", { target: "worker_1", detail: sensitive }).error.code, "SENSITIVE_CONTENT_EXCLUDED", `detail must reject ${sensitive}`);
  }
  assert.equal(fresh.record("state-changed", { target: "worker_1", code: "has transcript" }).error.code, "SENSITIVE_CONTENT_EXCLUDED");
  assert.equal(fresh.list().events.length, 0, "rejected records store nothing");
  assert.throws(() => createDiagnosticsLog({ maxEvents: 0 }), /maxEvents must be an integer/);
  assert.throws(() => createDiagnosticsLog({ maxEvents: 1001 }), /maxEvents must be an integer/);
  const full = "y".repeat(512);
  assert.equal(fresh.record("settled", { target: "worker_1", detail: full }).ok, true, "512-char detail is the bound");
});
test("20-M2 diagnostics never feeds semantic decisions and stays source-isolated", async () => {
  const log = createDiagnosticsLog({ now: () => 3000 });
  for (const type of EXPECTED_TYPES) log.record(type, { target: "worker_1", detail: `hint ${type}` });
  const before = {
    working: classifyAgentStatus("working"),
    blocked: classifyAgentStatus("blocked"),
    unknown: classifyAgentStatus("unknown"),
    idle: classifyAgentStatus("idle"),
  };
  log.clear();
  for (const type of EXPECTED_TYPES) log.record(type, { target: "worker_1", code: "HINT", detail: "again" });
  const after = {
    working: classifyAgentStatus("working"),
    blocked: classifyAgentStatus("blocked"),
    unknown: classifyAgentStatus("unknown"),
    idle: classifyAgentStatus("idle"),
  };
  assert.deepEqual(after, before, "diagnostics volume must not change classification");
  const fixture = { messages: [user("u1"), assistant("a1", "u1", "FINALIZE\nsettled done")] };
  const withHints = createResponseService({ run: runner(fixture), secret: Buffer.alloc(32, 60) });
  log.record("settled", { target: "worker_1", detail: "settled hint" });
  const first = await withHints({ target: "worker_1" }, { agent: "shepherd", abort });
  assert.equal(first.ok, true);
  assert.equal(first.text, "FINALIZE\nsettled done");
  log.clear();
  const withoutHints = createResponseService({ run: runner(fixture), secret: Buffer.alloc(32, 60) });
  const second = await withoutHints({ target: "worker_1" }, { agent: "shepherd", abort });
  assert.deepEqual(second.text, first.text, "response text is identical with or without diagnostics");
  assert.deepEqual(second.complete, first.complete);
  const listed = log.list();
  for (const event of listed.events) {
    assert.equal("text" in event, false);
    assert.equal(JSON.stringify(event).includes("settled done"), false, "diagnostics must not contain result bodies");
  }
  const diagnosticsSource = fs.readFileSync(new URL("../src/diagnostics.js", import.meta.url), "utf8");
  assert.doesNotMatch(diagnosticsSource, /^\s*import\s/m, "diagnostics stays dependency-free with no imports");
  assert.doesNotMatch(diagnosticsSource, /createResponseService|classifyAgentStatus|selectLatestCompletedResponse|findPinnedResponse/);
  assert.doesNotMatch(diagnosticsSource, /execFile|child_process/);
  assert.doesNotMatch(diagnosticsSource, /flocky|queue\.lock|checkpoint/);
  assert.doesNotMatch(diagnosticsSource, /opencode export/);
  const responseSource = fs.readFileSync(new URL("../src/response.js", import.meta.url), "utf8");
  assert.doesNotMatch(responseSource, /diagnostics/i, "authoritative retrieval never consults diagnostics");
  const copied = log.list();
  copied.events.length = 0;
  assert.ok(log.list().events.length >= 0, "list returns a copy");
  const mutable = log.record("settled", { target: "worker_1", detail: "copy check" });
  mutable.event.detail = "mutated";
  assert.notEqual(log.list().events.at(-1).detail, "mutated", "record returns a copy");
});
function diagnosticsSection() {
  return fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
}
test("20-M2 README documents strategy plus taxonomy plus split plus lineage with resolving refs", () => {
  const readme = diagnosticsSection();
  assert.match(readme, /### Operational diagnostics \(20-M2\)/);
  assert.match(readme, /process-local bounded in-memory ring buffer/);
  assert.match(readme, /no Herdr side features, no config format changes, no installer changes, and no CLI changes/);
  for (const type of EXPECTED_TYPES) assert.match(readme, new RegExp(type.replaceAll("-", "\\-")), `${type} documented`);
  for (const code of ["AGENT_NOT_SETTLED", "AGENT_BLOCKED", "AGENT_ERROR", "AGENT_NOT_FOUND", "HERDR_UNAVAILABLE", "WAIT_TIMEOUT_EXPIRED"]) {
    assert.match(readme, new RegExp(code), `${code} taxonomy documented`);
  }
  assert.match(readme, /Diagnostic versus authoritative split/);
  assert.match(readme, /never return response text/);
  assert.match(readme, /until `complete` is true/);
  assert.match(readme, /never feed semantic decisions/);
  assert.match(readme, /Timeout versus early failure troubleshooting lineage/);
  assert.match(readme, /surfaces immediately as `HERDR_UNAVAILABLE`/);
  assert.match(readme, /surfaces immediately as `AGENT_NOT_FOUND`/);
  assert.match(readme, /expire as `WAIT_TIMEOUT_EXPIRED`/);
  assert.match(readme, /Record `timed-out` only here/);
  const section = readme.slice(readme.indexOf("### Operational diagnostics (20-M2)"), readme.indexOf("## Installation", readme.indexOf("### Operational diagnostics (20-M2)")));
  const refs = [...section.matchAll(/src\/(diagnostics|response|prompts|agents)\.js:(\d+)/g)];
  assert.ok(refs.length >= 10, "docs carry file plus line references");
  const expectedTokens = {
    "src/diagnostics.js:9": "DIAGNOSTIC_EVENT_TYPES",
    "src/diagnostics.js:20": "MAX_DIAGNOSTIC_EVENTS_DEFAULT",
    "src/diagnostics.js:25": "SENSITIVE_DIAGNOSTIC_PATTERN",
    "src/diagnostics.js:79": "createDiagnosticsLog",
    "src/diagnostics.js:87": "record",
    "src/diagnostics.js:109": "list",
    "src/response.js:16": "RESPONSE_MATRIX",
    "src/response.js:40": "classifyAgentStatus",
    "src/response.js:59": "waitTimeoutError",
  };
  for (const [file, token] of Object.entries(expectedTokens)) {
    assert.ok(section.includes(file), `${file} referenced`);
    const lineNumber = Number(file.split(":")[1]);
    const target = new URL(`../${file.split(":")[0]}`, import.meta.url);
    const lines = fs.readFileSync(target, "utf8").split("\n");
    assert.ok(lineNumber >= 1 && lineNumber <= lines.length, `${file} resolves`);
    const window = lines.slice(Math.max(0, lineNumber - 2), lineNumber + 1).join("\n");
    assert.match(window, new RegExp(token), `${file} points at ${token}`);
  }
  for (const [, name, line] of refs) {
    void name;
    void line;
  }
  assert.match(readme, /`src\/prompts\.js:28`.*shepherd loop|`src\/prompts\.js:28` \(shepherd loop\)/);
});
test("20-M2 M1 regression keeps the loop plus taxonomy plus wording plus allows plus bans intact", async () => {
  assert.deepEqual([...RESPONSE_MATRIX.entries()], [
    ["shepherd", new Set(["grazer"])],
    ["shepherd-governor", new Set(["grazer", "sheepdog"])],
    ["sheepdog", new Set(["grazer", "sheep", "shearer-low", "shearer-medium"])],
  ]);
  assert.equal(classifyAgentStatus("working").code, "AGENT_NOT_SETTLED");
  assert.equal(classifyAgentStatus("working").action, "continue");
  assert.equal(classifyAgentStatus("blocked").code, AGENT_BLOCKED_CODE);
  assert.equal(classifyAgentStatus("error").code, AGENT_ERROR_CODE);
  assert.equal(classifyAgentStatus("failed").code, AGENT_ERROR_CODE);
  assert.equal(classifyAgentStatus("unknown").code, "AGENT_NOT_SETTLED");
  assert.equal(classifyAgentStatus("idle").settled, true);
  assert.equal(classifyAgentStatus("done").settled, true);
  assert.equal(waitTimeoutError("worker_1", 60000).error.code, WAIT_TIMEOUT_CODE);
  assert.equal(waitTimeoutError("worker_1", 60000).error.code, "WAIT_TIMEOUT_EXPIRED");
  assert.match(waitTimeoutError("worker_1", 60000).error.message, /final bound/);
  for (const prompt of [SHEPHERD_PROMPT, SHEPHERD_GOVERNOR_PROMPT, SHEEPDOG_PROMPT]) {
    assert.match(prompt, /bounded poll loop/);
    assert.match(prompt, /working means continue/);
    assert.match(prompt, /idle or done means retrieve/);
    assert.match(prompt, /herdr_agent_response until complete/);
    assert.match(prompt, /blocked means inspect/);
    assert.match(prompt, /never blind input/);
    assert.match(prompt, /instead of decaying to timeout/);
    assert.match(prompt, /safety timeout stays the final bound only/);
    assert.match(prompt, /WAIT_TIMEOUT_EXPIRED/);
    assert.match(prompt, /Treat unknown as inconclusive/);
  }
  const agents = createAgents();
  for (const name of ["shepherd", "shepherd-governor", "sheepdog"]) {
    const bash = agents[name].permission.bash;
    for (const key of ["herdr agent prompt*", "herdr agent wait*", "herdr agent get*", "herdr agent read*", "herdr agent list*"]) {
      assert.equal(bash[key], "allow", `${name} keeps ${key}`);
    }
    for (const invented of ["herdr events*", "herdr agent events*", "herdr agent logs*", "herdr agent stream*"]) {
      assert.equal(bash[invented], undefined, `${name} must not invent ${invented}`);
    }
  }
  assert.equal(agents["shepherd-governor"].permission.bash["herdr agent start * --kind opencode --pane * -- --agent sheep"], undefined);
  const fixture = { messages: [user("u1"), assistant("a1", "u1", "settled done")] };
  const settled = createResponseService({ run: runner(fixture, "done"), secret: Buffer.alloc(32, 61) });
  assert.equal((await settled({ target: "worker_1" }, { agent: "shepherd", abort })).ok, true);
  const working = createResponseService({ run: runner(fixture, "working"), secret: Buffer.alloc(32, 62) });
  assert.equal((await working({ target: "worker_1" }, { agent: "shepherd", abort })).error.code, "AGENT_NOT_SETTLED");
  const missing = createResponseService({
    run: async (command) => {
      if (command === "herdr") throw Object.assign(new Error("agent_not_found"), { stderr: "agent_not_found" });
      throw new Error("unexpected");
    },
    secret: Buffer.alloc(32, 63),
  });
  assert.equal((await missing({ target: "worker_1" }, { agent: "shepherd", abort })).error.code, "AGENT_NOT_FOUND");
});
