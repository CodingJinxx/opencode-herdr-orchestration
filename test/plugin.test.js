import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import plugin from "../src/index.js";
import { STATE_TOOLS } from "../src/agents.js";
import * as packageEntry from "../src/plugin.js";

function realpath(value) {
  return (fs.realpathSync.native ?? fs.realpathSync)(value);
}

test("npm package entry exports only the server plugin", () => {
  assert.deepEqual(Object.keys(packageEntry), ["server"]);
  assert.equal(packageEntry.server, plugin);
});

test("registers agents and injects per-session modes", async () => {
  const hooks = await plugin({}, {});
  assert.ok(hooks.tool.herdr_agent_response);
  const config = { agent: { grazer: { model: "custom/worker" } } };
  hooks.config(config);
  assert.equal(config.agent.grazer.model, "custom/worker");
  assert.ok(config.agent.shepherd);
  assert.ok(config.agent["shepherd-governor"]);
  assert.ok(config.agent.sheepdog);
  assert.ok(config.agent.sheep);

  await hooks["chat.message"]({ sessionID: "shepherd-session", agent: "shepherd" });
  await hooks["chat.message"]({ sessionID: "governor-session", agent: "shepherd-governor" });
  await hooks["chat.message"]({ sessionID: "sheepdog-session", agent: "sheepdog" });
  await hooks["chat.message"]({ sessionID: "sheep-session", agent: "sheep" });

  const shepherdOutput = { env: {} };
  const governorOutput = { env: {} };
  const sheepdogOutput = { env: {} };
  const sheepOutput = { env: {} };
  const unknownOutput = { env: {} };
  await hooks["shell.env"]({ sessionID: "shepherd-session", cwd: "C:/repo" }, shepherdOutput);
  await hooks["shell.env"]({ sessionID: "governor-session", cwd: "C:/repo" }, governorOutput);
  await hooks["shell.env"]({ sessionID: "sheepdog-session", cwd: "C:/repo" }, sheepdogOutput);
  await hooks["shell.env"]({ sessionID: "sheep-session", cwd: "C:/repo" }, sheepOutput);
  await hooks["shell.env"]({ sessionID: "other", cwd: "C:/repo" }, unknownOutput);
  assert.equal(shepherdOutput.env.SHEPHERD_MODE, "shepherd");
  assert.equal(governorOutput.env.SHEPHERD_MODE, "governor");
  assert.equal(sheepdogOutput.env.SHEPHERD_MODE, "sheepdog");
  assert.equal(sheepOutput.env.SHEPHERD_MODE, "sheep");
  assert.equal(unknownOutput.env.SHEPHERD_MODE, "none");
});

test("applies configured models by agent tier", async () => {
  const hooks = await plugin({}, {
    shepherdModel: "custom/shepherd",
    workerModel: "custom/worker",
    workerVariant: "high",
    grazerVariant: "low",
    sheepdogModel: "custom/sheepdog",
    sheepdogVariant: "medium",
    reviewerModel: "custom/reviewer",
  });
  const config = {};
  hooks.config(config);
  assert.equal(config.agent.shepherd.model, "custom/shepherd");
  assert.equal(config.agent["shepherd-governor"].model, "custom/shepherd");
  assert.equal(config.agent.grazer.model, "custom/worker");
  assert.equal(config.agent.grazer.variant, "low");
  assert.equal(config.agent.sheep.model, "custom/worker");
  assert.equal(config.agent.sheep.variant, "high");
  assert.equal(config.agent.sheepdog.model, "custom/sheepdog");
  assert.equal(config.agent.sheepdog.variant, "medium");
  assert.equal(config.agent["shearer-low"].model, "custom/reviewer");
  assert.equal(config.agent["shearer-medium"].model, "custom/reviewer");
});

test("applies documented shepherd tuple options to the planning shepherd only", async () => {
  const hooks = await plugin({}, {
    shepherdPermissions: {
      private_deployment_status: "allow",
    },
    shepherdPromptAppend: "Use private deployment tools according to local policy.",
  });
  const config = {};
  hooks.config(config);
  assert.equal(config.agent.shepherd.permission.private_deployment_status, "allow");
  assert.match(config.agent.shepherd.prompt, /Use private deployment tools according to local policy\.$/);
  assert.equal("private_deployment_status" in config.agent["shepherd-governor"].permission, false);
  assert.doesNotMatch(config.agent["shepherd-governor"].prompt, /private deployment tools/);
});

test("omits worker variant by default and uses separate sheepdog default", async () => {
  const hooks = await plugin({}, {});
  const config = {};
  hooks.config(config);
  for (const name of ["grazer", "sheep", "sheepdog"]) {
    assert.equal("variant" in config.agent[name], false);
  }
  assert.equal(config.agent.sheepdog.model, "litellm/glm-5.3-flash");
  assert.equal(config.agent["shearer-low"].variant, "low");
  assert.equal(config.agent["shearer-medium"].variant, "medium");
});

test("custom response tool returns structured output and metadata", async () => {
  const run = async (command) => {
    if (command === "herdr") {
      return JSON.stringify({
        result: {
          agent: {
            agent_status: "done",
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
    return JSON.stringify({
      messages: [
        { info: { id: "u1", role: "user" }, parts: [] },
        {
          info: {
            id: "a1",
            sessionID: "ses_worker",
            role: "assistant",
            parentID: "u1",
            agent: "grazer",
            finish: "stop",
            time: { completed: 2 },
          },
          parts: [{ type: "text", text: "FINALIZE\ncompleted research" }],
        },
      ],
    });
  };
  const hooks = await plugin({}, { response: { run, secret: Buffer.alloc(32, 9) } });
  let metadata;
  const output = await hooks.tool.herdr_agent_response.execute(
    { target: "worker_1" },
    {
      agent: "shepherd",
      abort: new AbortController().signal,
      metadata(value) {
        metadata = value;
      },
    },
  );
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.text, "FINALIZE\ncompleted research");
  assert.equal(result.reply.keyword, "FINALIZE");
  assert.equal(result.reply.milestone, true);
  assert.equal(metadata.metadata.messageID, "a1");
});

function stateRepository(prefix = "orchestration-plugin-state-") {
  const cwd = mkdtempSync(path.join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial", "-q"], { cwd });
  return finalizeRepository(cwd);
}

function finalizeRepository(cwd) {
  const run = (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  const commonDir = realpath(
    path.resolve(cwd, run(["rev-parse", "--git-common-dir"])),
  );
  const toplevel = realpath(path.resolve(cwd));
  return { cwd, toplevel, commonDir };
}

function linkStateWorktree(repo, branch = "linked-state-worktree") {
  const cwd = `${repo.cwd}-linked`;
  execFileSync("git", ["worktree", "add", "-b", branch, cwd], {
    cwd: repo.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return { cwd, toplevel: realpath(path.resolve(cwd)) };
}

function stateContext(agent, captured = []) {
  return {
    agent,
    abort: new AbortController().signal,
    metadata(value) {
      captured.push(value);
    },
  };
}

test("registers the four constrained state tools", async () => {
  const hooks = await plugin({}, { state: { cwd: tmpdir() } });
  for (const name of Object.values(STATE_TOOLS)) {
    assert.ok(hooks.tool[name], `plugin registers ${name}`);
  }
});

test("grants plan writes to the planning shepherd, plan reads to the governor and sheepdog, and execution state tools to sheepdog only", async () => {
  const repo = stateRepository();
  const hooks = await plugin({}, { state: { cwd: repo.cwd } });
  const execute = (name, agent, args) =>
    hooks.tool[name].execute(args, stateContext(agent)).then((output) => JSON.parse(output));

  const written = await execute(STATE_TOOLS.planWrite, "shepherd", {
    planId: "flock-plan-01",
    markdown: "# Plan\n\nImplement the state tools.\n",
  });
  assert.equal(written.ok, true);
  assert.equal(written.artifact.path, path.join(repo.commonDir, "flocky", "plans", "flock-plan-01.md"));

  const read = await execute(STATE_TOOLS.planRead, "shepherd", { planId: "flock-plan-01" });
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Plan\n\nImplement the state tools.\n");

  const deniedGovernorWrite = await execute(STATE_TOOLS.planWrite, "shepherd-governor", {
    planId: "flock-plan-02",
    markdown: "# Contracts are not plans\n",
  });
  assert.equal(deniedGovernorWrite.ok, false);
  assert.equal(deniedGovernorWrite.error.code, "UNAUTHORIZED_AGENT");
  const governorRead = await execute(STATE_TOOLS.planRead, "shepherd-governor", { planId: "flock-plan-01" });
  assert.equal(governorRead.ok, true);

  const sheepdogPlanRead = await execute(STATE_TOOLS.planRead, "sheepdog", { planId: "flock-plan-01" });
  assert.equal(sheepdogPlanRead.ok, true, "sheepdog reads the authoritative plan directly");
  const deniedPlanWrite = await execute(STATE_TOOLS.planWrite, "sheepdog", {
    planId: "flock-plan-03",
    markdown: "# Sheepdog may not author plans\n",
  });
  assert.equal(deniedPlanWrite.ok, false);
  assert.equal(deniedPlanWrite.error.code, "UNAUTHORIZED_AGENT");

  const execution = await execute(STATE_TOOLS.executionWrite, "sheepdog", {
    planId: "flock-plan-01",
    markdown: "# Execution\n\nSquad one integrated.\n",
  });
  assert.equal(execution.ok, true);
  assert.equal(execution.artifact.path, path.join(repo.commonDir, "flocky", "executions", "flock-plan-01.md"));
  const executionRead = await execute(STATE_TOOLS.executionRead, "sheepdog", { planId: "flock-plan-01" });
  assert.equal(executionRead.ok, true);
  assert.equal(executionRead.artifact.markdown, "# Execution\n\nSquad one integrated.\n");

  const deniedExecution = await execute(STATE_TOOLS.executionRead, "shepherd", { planId: "flock-plan-01" });
  assert.equal(deniedExecution.ok, false);
  assert.equal(deniedExecution.error.code, "UNAUTHORIZED_AGENT");
  const governorDeniedExecution = await execute(STATE_TOOLS.executionRead, "shepherd-governor", { planId: "flock-plan-01" });
  assert.equal(governorDeniedExecution.error.code, "UNAUTHORIZED_AGENT");
});

test("denies state tools to flock leaves and reviewers", async () => {
  const repo = stateRepository();
  const hooks = await plugin({}, { state: { cwd: repo.cwd } });
  for (const agent of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    for (const name of [STATE_TOOLS.planRead, STATE_TOOLS.executionRead]) {
      const output = await hooks.tool[name].execute({ planId: "flock-plan-01" }, stateContext(agent));
      const result = JSON.parse(output);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "UNAUTHORIZED_AGENT", `${agent} may not use ${name}`);
    }
  }
});

test("shares state across linked worktrees but never across clones", async () => {
  const repo = stateRepository();
  const linked = linkStateWorktree(repo);
  const hooks = await plugin({}, { state: { cwd: repo.cwd } });
  const execute = (hooks_, name, agent, args) =>
    hooks_.tool[name].execute(args, stateContext(agent)).then((output) => JSON.parse(output));

  const written = await execute(hooks, STATE_TOOLS.planWrite, "shepherd", {
    planId: "shared-01",
    markdown: "# Shared plan\n",
  });
  assert.equal(written.ok, true);

  const linkedHooks = await plugin({}, { state: { cwd: linked.cwd } });
  const fromLinked = await execute(linkedHooks, STATE_TOOLS.planRead, "shepherd", { planId: "shared-01" });
  assert.equal(fromLinked.ok, true, "linked worktrees sharing the common directory read the same artifacts");

  const clonePath = `${repo.cwd}-clone`;
  execFileSync("git", ["clone", "-q", repo.cwd, clonePath], { windowsHide: true });
  const cloneHooks = await plugin({}, { state: { cwd: clonePath } });
  const fromClone = await execute(cloneHooks, STATE_TOOLS.planRead, "shepherd", { planId: "shared-01" });
  assert.equal(fromClone.ok, false, "state does not cross clones");
  assert.equal(fromClone.error.code, "NOT_FOUND");

  const cloneCommonDir = realpath(path.resolve(clonePath, ".git"));
  const artifact = path.join(repo.commonDir, "flocky", "plans", "shared-01.md");
  fs.mkdirSync(path.join(cloneCommonDir, "flocky", "plans"), { recursive: true });
  fs.copyFileSync(artifact, path.join(cloneCommonDir, "flocky", "plans", "shared-01.md"));
  const copied = await execute(cloneHooks, STATE_TOOLS.planRead, "shepherd", { planId: "shared-01" });
  assert.equal(copied.ok, false, "a copied artifact from a foreign clone is rejected");
  assert.equal(copied.error.code, "IDENTITY_MISMATCH");
});

test("state tools never issue arbitrary Git metadata writes", async () => {
  const repo = stateRepository();
  const gitCalls = [];
  const runGit = async (cwd, args) => {
    gitCalls.push(args);
    const { stdout } = await promisify(execFile)("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout;
  };
  const hooks = await plugin({}, { state: { cwd: repo.cwd, runGit } });
  const execute = (name, agent, args) =>
    hooks.tool[name].execute(args, stateContext(agent)).then((output) => JSON.parse(output));

  const written = await execute(STATE_TOOLS.planWrite, "shepherd", {
    planId: "safe-01",
    markdown: "# Safe plan\n",
  });
  assert.equal(written.ok, true);
  const read = await execute(STATE_TOOLS.planRead, "shepherd", { planId: "safe-01" });
  assert.equal(read.ok, true);
  const execution = await execute(STATE_TOOLS.executionWrite, "sheepdog", {
    planId: "safe-01",
    markdown: "# Safe execution\n",
  });
  assert.equal(execution.ok, true);

  assert.ok(gitCalls.length > 0, "the state service still resolves repository identity through Git");
  for (const args of gitCalls) {
    assert.ok(
      args[0] === "rev-parse" && (args[1] === "--git-common-dir" || args[1] === "--show-toplevel"),
      `only read-only rev-parse is permitted, saw: git ${args.join(" ")}`,
    );
  }

  const plansDir = path.join(repo.commonDir, "flocky", "plans");
  assert.deepEqual(
    fs.readdirSync(plansDir).filter((entry) => entry.endsWith(".md")),
    ["safe-01.md"],
    "state is durable plain Markdown under the shared common directory",
  );
});
