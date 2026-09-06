import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "jsonc-parser";

import plugin from "../src/index.js";
import {
  DEVELOPER_AGENT,
  ORCHESTRATION_ROLES,
  STEERING_TOOL_ACCESS,
  STEERING_TOOLS,
  createAgents,
} from "../src/agents.js";
import {
  STEER_COMMAND_AGENT,
  STEER_COMMAND_DESCRIPTION,
  STEER_COMMAND_NAME,
  STEER_COMMAND_TEMPLATE,
  createSteerCommandHook,
  isSteerAllowedAgent,
  parseSteerArguments,
  resolveSessionAgentViaClient,
  steerCommandEntry,
} from "../src/steer.js";
import {
  isSteerCommandConfigured,
  updateCommandConfig,
  updateSteerCommand,
  writeSteerCommand,
} from "../src/installer.js";

function realpath(value) {
  return (fs.realpathSync.native ?? fs.realpathSync)(value);
}

function stateRepository(prefix = "orchestration-steer-") {
  const cwd = mkdtempSync(path.join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial", "-q"], { cwd });
  const commonDir = realpath(path.resolve(cwd, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim()));
  return { cwd, commonDir };
}

function steeringRootFor(repo) {
  return path.join(repo.commonDir, "flocky", "steering");
}

function hookWithAgent(repo, agent) {
  return createSteerCommandHook({
    stateOptions: { cwd: repo.cwd },
    resolveAgent: async () => agent,
  });
}

async function assertThrowsAsync(fn) {
  let error;
  try {
    await fn();
  } catch (cause) {
    error = cause;
  }
  assert.ok(error instanceof Error, "hook must throw to abort before any model turn");
  return error;
}

test("steer hook shares the Developer-only allowlist as a single source with the submit tool", () => {
  assert.equal(STEER_COMMAND_NAME, "steer");
  assert.equal(isSteerAllowedAgent("developer"), true);
  assert.equal(isSteerAllowedAgent(DEVELOPER_AGENT), true);
  assert.deepEqual([...STEERING_TOOL_ACCESS.get(STEERING_TOOLS.submit)], [DEVELOPER_AGENT]);
  for (const role of ORCHESTRATION_ROLES) {
    assert.equal(isSteerAllowedAgent(role), false, `${role} must be denied`);
  }
  for (const agent of ["unknown", "ambiguous", "none", "", null, undefined]) {
    assert.equal(isSteerAllowedAgent(agent), false, `agent ${JSON.stringify(agent)} must be denied`);
  }
});

test("steer arguments parse content and explicit planId with state-identical validation shape", () => {
  assert.deepEqual(parseSteerArguments("Hold scope."), { content: "Hold scope." });
  assert.deepEqual(parseSteerArguments("my-plan-01 :: Hold scope."), { planId: "my-plan-01", content: "Hold scope." });
  assert.deepEqual(parseSteerArguments("  my-plan-01  ::  Hold scope.  "), { planId: "my-plan-01", content: "Hold scope." });
  // Prose containing :: with whitespace on the left stays content.
  assert.deepEqual(parseSteerArguments("note with spaces :: stays content"), { content: "note with spaces :: stays content" });
  // Single-token invalid planId passes through so state reports INVALID_PLAN_ID identically.
  assert.deepEqual(parseSteerArguments(".bad :: content"), { planId: ".bad", content: "content" });
  assert.deepEqual(parseSteerArguments("", ), { content: "" });
  assert.deepEqual(parseSteerArguments(undefined), { content: "" });
});

test("steer command entry pins developer agent with ARGUMENTS template and description", () => {
  const entry = steerCommandEntry();
  assert.equal(entry.agent, "developer");
  assert.equal(entry.agent, STEER_COMMAND_AGENT);
  assert.equal(entry.description, STEER_COMMAND_DESCRIPTION);
  assert.ok(entry.template.includes("$ARGUMENTS"), "template must carry $ARGUMENTS");
  assert.equal(entry.template, STEER_COMMAND_TEMPLATE);
});

test("developer profile holds only the submit tool with no spawn rights and no spawn matrix membership", () => {
  const agents = createAgents();
  const developer = agents.developer;
  assert.ok(developer, "developer profile is registered");
  assert.equal(developer.mode, "primary");
  assert.equal(developer.permission[STEERING_TOOLS.submit], "allow");
  for (const tool of ["herdr_plan_write", "herdr_plan_read", "herdr_execution_write", "herdr_execution_read"]) {
    assert.equal(developer.permission[tool], "deny", `developer must deny ${tool}`);
  }
  for (const tool of ["herdr_steering_check", "herdr_steering_read", "herdr_steering_consume"]) {
    assert.equal(developer.permission[tool], "deny", `developer must deny ${tool}`);
  }
  for (const tool of ["herdr_ownership_claim", "herdr_ownership_read", "herdr_ownership_sync", "herdr_ownership_snapshot", "herdr_ownership_correct"]) {
    assert.equal(developer.permission[tool], "deny", `developer must deny ${tool}`);
  }
  assert.equal(developer.permission.task, "deny");
  assert.equal(developer.permission.bash["*"], "deny");
  const spawnPattern = `herdr agent start * --kind opencode --pane * -- --agent ${DEVELOPER_AGENT}`;
  for (const role of [...ORCHESTRATION_ROLES, "developer"]) {
    assert.equal(agents[role].permission.bash?.[spawnPattern], undefined, `${role} must not spawn developer`);
  }
  for (const name of Object.keys(agents)) {
    if (name === "developer") continue;
    assert.equal(agents.developer.permission.bash?.[`herdr agent start * --kind opencode --pane * -- --agent ${name}`], undefined, `developer must not spawn ${name}`);
  }
});

test("steer hook writes directly via the existing state service with tool parity and no parallel store", async () => {
  const repo = stateRepository();
  const hooks = await plugin({}, { state: { cwd: repo.cwd } });
  const hook = hookWithAgent(repo, "developer");

  const output = { parts: [] };
  const thrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "ses_dev_01", arguments: "parity-plan :: Hook parity content." }, output));
  assert.match(thrown.message, /Steering recorded: st_[0-9a-f]{16} for target parity-plan#1/);
  assert.equal(output.parts.length, 1);
  assert.equal(output.parts[0].type, "text");
  assert.match(output.parts[0].text, /st_[0-9a-f]{16}/);
  assert.match(output.parts[0].text, /parity-plan#1/);

  const entriesDir = path.join(steeringRootFor(repo), "parity-plan", "entries");
  const files = fs.readdirSync(entriesDir);
  assert.equal(files.length, 1);
  const stored = JSON.parse(fs.readFileSync(path.join(entriesDir, files[0]), "utf8"));
  assert.equal(stored.content, "Hook parity content.");
  assert.equal(stored.planId, "parity-plan");
  assert.equal(stored.sequence, 1);
  assert.equal(stored.provenance.submitter, "developer");

  // Same store: the submit tool appends sequence 2 to the hook-written target.
  const toolOutput = await hooks.tool[STEERING_TOOLS.submit].execute(
    { planId: "parity-plan", content: "Tool second." },
    { agent: "developer", abort: new AbortController().signal, metadata() {} },
  );
  const second = JSON.parse(toolOutput);
  assert.equal(second.ok, true);
  assert.equal(second.entry.sequence, 2);
  assert.equal(fs.readdirSync(entriesDir).length, 2);
});

test("steer hook infers single target identically to the submit tool", async () => {
  const repo = stateRepository();
  const hooks = await plugin({}, { state: { cwd: repo.cwd } });
  const seed = await hooks.tool[STEERING_TOOLS.submit].execute(
    { planId: "single-plan", content: "Seed." },
    { agent: "developer", abort: new AbortController().signal, metadata() {} },
  );
  assert.equal(JSON.parse(seed).ok, true);
  const hook = hookWithAgent(repo, "developer");
  const output = { parts: [] };
  const thrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "ses_dev_01", arguments: "Inferred content." }, output));
  assert.match(thrown.message, /for target single-plan#2/);
  assert.match(output.parts[0].text, /single-plan#2/);
});

test("steer hook denies all seven orchestration roles with no filesystem write", async () => {
  for (const role of ORCHESTRATION_ROLES) {
    const repo = stateRepository();
    const hook = hookWithAgent(repo, role);
    const output = { parts: [] };
    const thrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "ses_worker", arguments: "Must not land." }, output));
    assert.match(thrown.message, /Steering denied/, `${role} denial must throw`);
    assert.match(output.parts[0].text, /Steering denied/);
    assert.equal(fs.existsSync(steeringRootFor(repo)), false, `${role} must write nothing`);
  }
});

test("steer hook fails closed on unresolvable session agent with no filesystem write", async () => {
  const cases = [
    ["undefined agent", async () => undefined],
    ["empty agent", async () => ""],
    ["null agent", async () => null],
    ["unknown agent", async () => "unknown"],
    ["throwing resolver", async () => { throw new Error("lookup failed"); }],
  ];
  for (const [label, resolveAgent] of cases) {
    const repo = stateRepository();
    const hook = createSteerCommandHook({ stateOptions: { cwd: repo.cwd }, resolveAgent });
    const output = { parts: [] };
    const thrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "ses_01", arguments: "Must not land." }, output));
    assert.match(thrown.message, /Steering denied/, `${label} must fail closed`);
    assert.equal(fs.existsSync(steeringRootFor(repo)), false, `${label} must write nothing`);
  }

  // Missing client plus missing session also fails closed.
  const repo = stateRepository();
  const hook = createSteerCommandHook({ stateOptions: { cwd: repo.cwd }, client: undefined });
  const output = { parts: [] };
  const thrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "", arguments: "Must not land." }, output));
  assert.match(thrown.message, /Steering denied/);
  assert.equal(fs.existsSync(steeringRootFor(repo)), false);
});

test("steer hook resolves worker versus developer agents via the SDK client", async () => {
  const repo = stateRepository();
  const developerClient = {
    session: {
      messages: async () => ({ data: [{ info: { agent: "developer" }, parts: [] }] }),
    },
  };
  const workerClient = {
    session: {
      messages: async () => ({ data: [{ info: { agent: "sheepdog" }, parts: [] }] }),
    },
  };
  assert.equal(await resolveSessionAgentViaClient(developerClient, "ses_dev"), "developer");
  assert.equal(await resolveSessionAgentViaClient(workerClient, "ses_work"), "sheepdog");
  assert.equal(await resolveSessionAgentViaClient(undefined, "ses_dev"), undefined);
  assert.equal(await resolveSessionAgentViaClient({ session: { messages: async () => { throw new Error("gone"); } } }, "ses_dev"), undefined);

  const allowed = createSteerCommandHook({ stateOptions: { cwd: repo.cwd }, client: developerClient });
  const allowedOutput = { parts: [] };
  const confirmation = await assertThrowsAsync(() => allowed({ command: "steer", sessionID: "ses_dev", arguments: "sdk-plan :: Via SDK client." }, allowedOutput));
  assert.match(confirmation.message, /Steering recorded/);

  const deniedRepo = stateRepository();
  const denied = createSteerCommandHook({ stateOptions: { cwd: deniedRepo.cwd }, client: workerClient });
  const deniedOutput = { parts: [] };
  const denial = await assertThrowsAsync(() => denied({ command: "steer", sessionID: "ses_work", arguments: "Denied via SDK." }, deniedOutput));
  assert.match(denial.message, /Steering denied/);
  assert.equal(fs.existsSync(steeringRootFor(deniedRepo)), false);
});

test("steer hook confirmation carries steering id plus resolved target with parts fallback", async () => {
  const repo = stateRepository();
  const hook = hookWithAgent(repo, "developer");
  const output = { parts: [] };
  const thrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "ses_dev_01", arguments: "confirm-plan :: Confirm me." }, output));
  const idMatch = thrown.message.match(/st_[0-9a-f]{16}/);
  assert.ok(idMatch, "throw carries steering id");
  assert.match(thrown.message, /for target confirm-plan#1/);
  assert.equal(output.parts.length, 1, "minimal parts fallback carries one text part");
  assert.equal(output.parts[0].type, "text");
  assert.ok(output.parts[0].text.includes(idMatch[0]), "parts fallback carries the same id");
  assert.match(output.parts[0].text, /confirm-plan#1/);
});

test("steer hook keeps validation parity with the submit tool and writes nothing on failure", async () => {
  const repo = stateRepository();
  const hook = hookWithAgent(repo, "developer");

  const emptyOutput = { parts: [] };
  const emptyThrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "ses_dev", arguments: "   " }, emptyOutput));
  assert.match(emptyThrown.message, /INVALID_STEERING_CONTENT/);

  const oversized = "x".repeat(8193);
  const bigOutput = { parts: [] };
  const bigThrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "ses_dev", arguments: oversized }, bigOutput));
  assert.match(bigThrown.message, /INVALID_STEERING_CONTENT/);

  const badPlanOutput = { parts: [] };
  const badPlanThrown = await assertThrowsAsync(() => hook({ command: "steer", sessionID: "ses_dev", arguments: ".bad :: content" }, badPlanOutput));
  assert.match(badPlanThrown.message, /INVALID_PLAN_ID/);

  assert.equal(fs.existsSync(steeringRootFor(repo)), false, "validation failures write nothing");
});

test("steer hook ignores non-steer commands without throwing", async () => {
  const repo = stateRepository();
  const hook = hookWithAgent(repo, "developer");
  const output = { parts: [] };
  await hook({ command: "other", sessionID: "ses_dev", arguments: "anything" }, output);
  assert.equal(output.parts.length, 0);
  assert.equal(fs.existsSync(steeringRootFor(repo)), false);
});

test("plugin exposes command.execute.before for steer with throw-to-abort confirmation", async () => {
  const repo = stateRepository();
  const hooks = await plugin({ client: undefined }, { state: { cwd: repo.cwd }, steerResolveAgent: async () => "developer" });
  assert.equal(typeof hooks["command.execute.before"], "function");
  const output = { parts: [] };
  const thrown = await assertThrowsAsync(() => hooks["command.execute.before"]({ command: "steer", sessionID: "ses_dev", arguments: "plugin-plan :: Via plugin hook." }, output));
  assert.match(thrown.message, /Steering recorded/);
  assert.match(output.parts[0].text, /plugin-plan#1/);

  const deniedHooks = await plugin({ client: undefined }, { state: { cwd: repo.cwd }, steerResolveAgent: async () => "sheep" });
  const deniedOutput = { parts: [] };
  const denial = await assertThrowsAsync(() => deniedHooks["command.execute.before"]({ command: "steer", sessionID: "ses_work", arguments: "Denied." }, deniedOutput));
  assert.match(denial.message, /Steering denied/);
});

test("installer owns the steer command entry with agent pin plus ARGUMENTS template plus description", () => {
  const entry = steerCommandEntry();
  assert.equal(entry.agent, "developer");
  assert.ok(entry.template.includes("$ARGUMENTS"));
  assert.equal(entry.description, STEER_COMMAND_DESCRIPTION);

  const base = `{\n  // Keep this comment.\n  "plugin": ["other"]\n}\n`;
  const added = updateSteerCommand(base);
  assert.match(added, /Keep this comment/);
  const parsed = parse(added);
  assert.equal(parsed.plugin[0], "other");
  assert.equal(parsed.command.steer.agent, "developer");
  assert.ok(parsed.command.steer.template.includes("$ARGUMENTS"));
  assert.equal(parsed.command.steer.description, STEER_COMMAND_DESCRIPTION);
  assert.ok(isSteerCommandConfigured(added));

  const removed = updateSteerCommand(added, undefined, true);
  assert.equal(isSteerCommandConfigured(removed), false);
  assert.deepEqual(parse(removed).plugin, ["other"]);

  // Removing when absent is idempotent and preserves the source.
  assert.equal(updateCommandConfig("{}", "steer", undefined, true), "{}");

  // Invalid JSONC fails closed.
  assert.throws(() => updateSteerCommand("{ not json", undefined, false), /Invalid OpenCode JSONC/);
});

test("installer writeSteerCommand preserves comments with backup discipline", () => {
  const { mkdtempSync: mkdtemp, writeFileSync: writeFile, readFileSync: readFile, existsSync: exists } = fs;
  const dir = mkdtemp(path.join(tmpdir(), "orchestration-steer-installer-"));
  const file = path.join(dir, "opencode.jsonc");
  writeFile(file, `{\n  // Keep me.\n  "plugin": []\n}\n`, "utf8");
  const first = writeSteerCommand(dir, false);
  assert.equal(first.changed, true);
  assert.ok(first.backup && exists(first.backup));
  assert.match(readFile(file, "utf8"), /Keep me/);
  assert.ok(isSteerCommandConfigured(readFile(file, "utf8")));
  const second = writeSteerCommand(dir, false);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  const removed = writeSteerCommand(dir, true);
  assert.equal(removed.changed, true);
  assert.equal(isSteerCommandConfigured(readFile(file, "utf8")), false);
});
