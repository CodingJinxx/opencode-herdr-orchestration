import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import {
  createAgents,
  DEVELOPER_AGENT,
  mergeAgent,
  ORCHESTRATION_ROLES,
  OWNERSHIP_TOOL_ACCESS,
  OWNERSHIP_TOOLS,
  RAW_STEERING_TOOL_ACCESS,
  RAW_STEERING_TOOLS,
  SHEPHERD_PHASES,
  STATE_TOOL_ACCESS,
  STEERING_TOOL_ACCESS,
  STEERING_TOOLS,
} from "../src/agents.js";
import { createStateTools, createSteeringTools, modeForAgent } from "../src/index.js";
import {
  GRAZER_PROMPT,
  SHEEPDOG_PROMPT,
  SHEEP_PROMPT,
  SHEARER_REVIEW_PROMPT,
  SHEPHERD_GOVERNOR_PROMPT,
  SHEPHERD_PROMPT,
} from "../src/prompts.js";

const OLD_ROLES = [
  "shepherd-plan",
  "shepherd-build",
  "sheep-plan",
  "sheep-build",
  "shearer-review-low",
  "shearer-review-medium",
];

const NEW_ROLES = [
  "grazer",
  "shearer-low",
  "shearer-medium",
  "sheep",
  "sheepdog",
  "shepherd",
  "shepherd-governor",
];

const SPAWN_ROLES = ["grazer", "sheep", "sheepdog", "shearer-low", "shearer-medium", "shepherd", "shepherd-governor"];

function spawnPattern(role) {
  return `herdr agent start * --kind opencode --pane * -- --agent ${role}`;
}

test("registers the closed new role topology with no old roles or aliases", () => {
  const agents = createAgents();
  assert.deepEqual(Object.keys(agents).sort(), NEW_ROLES);
  for (const role of OLD_ROLES) {
    assert.equal(agents[role], undefined);
  }
});

test("applies the approved spawn matrix", () => {
  const agents = createAgents();
  const bash = (name) => agents[name].permission.bash;

  assert.equal(bash("shepherd")[spawnPattern("grazer")], "allow");
  for (const role of ["sheep", "sheepdog", "shearer-low", "shearer-medium", "shepherd", "shepherd-governor"]) {
    assert.equal(bash("shepherd")[spawnPattern(role)], undefined, `shepherd must not spawn ${role}`);
  }

  for (const role of ["grazer", "sheepdog"]) {
    assert.equal(bash("shepherd-governor")[spawnPattern(role)], "allow");
  }
  for (const role of ["sheep", "shearer-low", "shearer-medium", "shepherd"]) {
    assert.equal(bash("shepherd-governor")[spawnPattern(role)], undefined, `governor must not spawn ${role}`);
  }

  for (const role of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(bash("sheepdog")[spawnPattern(role)], "allow");
  }
  for (const role of ["shepherd", "shepherd-governor"]) {
    assert.equal(bash("sheepdog")[spawnPattern(role)], undefined, `sheepdog must not spawn ${role}`);
  }

  for (const name of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    for (const role of SPAWN_ROLES) {
      assert.equal(bash(name)[spawnPattern(role)], undefined, `${name} must not spawn ${role}`);
    }
  }
});

test("applies the approved response retrieval matrix to tool permissions", () => {
  const agents = createAgents();
  for (const name of ["shepherd", "shepherd-governor", "sheepdog"]) {
    assert.equal(agents[name].permission.herdr_agent_response, "allow");
  }
  for (const name of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(agents[name].permission.herdr_agent_response, "deny");
  }
});

test("applies the approved state tool matrix to agent permissions", () => {
  const agents = createAgents();

  const shepherd = agents.shepherd.permission;
  assert.equal(shepherd.herdr_plan_write, "allow", "shepherd may write plans");
  assert.equal(shepherd.herdr_plan_read, "allow", "shepherd may read plans");
  assert.equal(shepherd.herdr_execution_write, "deny", "shepherd may not write executions");
  assert.equal(shepherd.herdr_execution_read, "deny", "shepherd may not read executions");

  const governor = agents["shepherd-governor"].permission;
  assert.equal(governor.herdr_plan_write, "deny", "governor may not write plans");
  assert.equal(governor.herdr_plan_read, "allow", "governor may read plans");
  assert.equal(governor.herdr_execution_write, "deny", "governor may not write executions");
  assert.equal(governor.herdr_execution_read, "deny", "governor may not read executions");

  const sheepdog = agents.sheepdog.permission;
  assert.equal(sheepdog.herdr_plan_read, "allow", "sheepdog may read the authoritative plan");
  assert.equal(sheepdog.herdr_execution_write, "allow", "sheepdog may write executions");
  assert.equal(sheepdog.herdr_execution_read, "allow", "sheepdog may read executions");
  assert.equal(sheepdog.herdr_plan_write, "deny", "sheepdog may not write plans");

  for (const name of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    for (const tool of [
      "herdr_plan_write",
      "herdr_plan_read",
      "herdr_execution_write",
      "herdr_execution_read",
    ]) {
      assert.equal(agents[name].permission[tool], "deny", `${name} may not use ${tool}`);
    }
  }
});

test("exposes the same state tool names to agents and plugin enforcement", async () => {
  const { createStateTools } = await import("../src/index.js");
  const tools = createStateTools({ cwd: tmpdir() });
  assert.deepEqual([...STATE_TOOL_ACCESS.keys()].sort(), [
    "herdr_execution_read",
    "herdr_execution_write",
    "herdr_plan_read",
    "herdr_plan_write",
  ]);
  for (const [name, allowed] of STATE_TOOL_ACCESS) {    assert.ok(tools[name], `plugin registers ${name}`);
    for (const agent of allowed) {
      assert.equal(createAgents()[agent].permission[name], "allow", `${agent} is allowed ${name}`);
    }
  }
});

test("pins shearer variants to GPT-5.6 Terra", () => {
  const agents = createAgents();
  assert.equal(agents["shearer-low"].model, "litellm-responses/gpt-5.6-terra");
  assert.equal(agents["shearer-low"].variant, "low");
  assert.equal(agents["shearer-medium"].model, "litellm-responses/gpt-5.6-terra");
  assert.equal(agents["shearer-medium"].variant, "medium");
});

test("governor is the semantic authority on the shepherd model, not a reviewer", () => {
  const agents = createAgents({ shepherdModel: "custom/shepherd" });
  const governor = agents["shepherd-governor"];
  assert.equal(governor.model, "custom/shepherd");
  assert.equal(governor.permission.edit["**/*.md"], "allow");
  const bash = governor.permission.bash;
  assert.equal(bash["git push*"], "allow");
  assert.equal(bash["git merge*"], "allow");
  assert.equal(bash["gh pr create*"], "allow");
  assert.equal(bash["git push --force*"], "deny");
  assert.equal(bash["git commit --amend*"], "deny");
  assert.equal(bash["git commit *--amend*"], "deny");
  assert.equal(bash["*"], "deny");
  assert.match(governor.prompt, /You are not a reviewer/);
  assert.match(governor.prompt, /never perform semantic review yourself/);
  assert.doesNotMatch(governor.prompt, /exactly one verdict/);
  assert.match(governor.prompt, /final delivery/);
});

test("governor reads plans but never writes them and leaves worktrees to sheepdog", () => {
  const agents = createAgents();
  const governor = agents["shepherd-governor"];
  const bash = governor.permission.bash;
  assert.equal(bash["herdr worktree create*"], "deny");
  assert.equal(bash["herdr worktree open*"], "deny");
  assert.equal(bash["herdr worktree remove*"], "deny");
  assert.equal(bash["git worktree list*"], "allow");
  assert.equal(bash["git worktree add*"], "deny");
  assert.equal(bash["git worktree remove*"], "deny");
  assert.equal(bash["git worktree prune*"], "deny");
  assert.match(governor.prompt, /herdr_plan_read/);
  assert.doesNotMatch(governor.prompt, /herdr_plan_write/);
  assert.match(governor.prompt, /never write one/);
  assert.match(governor.prompt, /Sheepdog owns worker worktrees/);
});

test("sheepdog owns worker worktrees through the Herdr worktree lifecycle", () => {
  const agents = createAgents();
  const sheepdog = agents.sheepdog;
  const bash = sheepdog.permission.bash;
  assert.equal(bash["herdr worktree create *"], "allow");
  assert.equal(bash["herdr worktree open *"], "allow");
  assert.equal(bash["herdr worktree remove --workspace *"], "allow");
  assert.equal(bash["herdr worktree remove * --force*"], "deny");
  assert.equal(bash["git worktree*"], "deny");
  assert.match(sheepdog.prompt, /Prepare each sheep's branch and worktree yourself/);
  assert.match(sheepdog.prompt, /peers sharing the same Git common repository/);
  assert.match(sheepdog.prompt, /never nest a worker checkout/);
  assert.match(sheepdog.prompt, /never force removal/);
});

test("sheepdog owns validation, review tiers, retries, and conflict recovery", () => {
  const { prompt } = createAgents().sheepdog;
  assert.match(prompt, /Run or delegate the repository's deterministic checks before spending a semantic review cycle/);
  assert.match(prompt, /Choose the shearer tier for each review/);
  assert.match(prompt, /shearer-low for localized mechanical changes/);
  assert.match(prompt, /shearer-medium for security/);
  assert.match(prompt, /You own leaf retries/);
  assert.match(prompt, /recover by re-scoping ownership and issuing bounded recovery contracts/);
  assert.match(prompt, /escalate to shepherd-governor when conflicts invalidate the plan/);
  assert.match(prompt, /hand-resolve conflicts/);
  assert.doesNotMatch(prompt, /prepared by shepherd-governor/);
});

test("shepherd and sheepdog never amend commits", () => {
  const agents = createAgents();
  assert.equal(agents.shepherd.permission.bash["git commit --amend*"], "deny");
  assert.equal(agents.shepherd.permission.bash["git commit * --amend*"], "deny");
  assert.equal(agents.sheepdog.permission.bash["git commit --amend*"], "deny");
  assert.equal(agents.sheepdog.permission.bash["git commit * --amend*"], "deny");
  assert.match(SHEEP_PROMPT, /never commit with --no-verify or --amend/);
});

test("shepherd plans without delivery authority", () => {
  const agents = createAgents();
  const bash = agents.shepherd.permission.bash;
  assert.equal(bash["git push*"], "deny");
  assert.equal(bash["git merge*"], undefined);
  assert.equal(bash["gh pr create*"], undefined);
});

test("sheepdog uses its own separate model", () => {
  const agents = createAgents({ sheepdogModel: "custom/dog" });
  assert.equal(agents.sheepdog.model, "custom/dog");
  assert.equal(createAgents().sheepdog.model, "litellm/glm-5.3-flash");
});

test("supports grazer-specific variant with workerVariant fallback", () => {
  const withFallback = createAgents({ workerVariant: "high" });
  assert.equal(withFallback.grazer.variant, "high");
  assert.equal(withFallback.sheep.variant, "high");

  const withOverride = createAgents({ workerVariant: "high", grazerVariant: "low" });
  assert.equal(withOverride.grazer.variant, "low");
  assert.equal(withOverride.sheep.variant, "high");
});

test("keeps workers and reviewers as leaves", () => {
  const agents = createAgents();
  for (const name of ["grazer", "sheep", "sheepdog", "shearer-low", "shearer-medium", "shepherd-governor"]) {
    assert.equal(agents[name].permission.task, "deny");
  }
  for (const name of ["grazer", "sheepdog", "shearer-low", "shearer-medium"]) {
    assert.equal(agents[name].permission.edit, "deny");
  }
  for (const name of ["grazer", "shearer-low", "shearer-medium"]) {
    assert.equal(agents[name].permission.bash["*"], "deny");
  }
});

test("hardens sheep against Herdr, GitHub, remote, and destructive Git operations", () => {
  const bash = createAgents().sheep.permission.bash;
  for (const denied of [
    "herdr*",
    "gh*",
    "npm publish*",
    "git push*",
    "git pull*",
    "git fetch*",
    "git remote*",
    "git merge*",
    "git cherry-pick*",
    "git rebase*",
    "git reset*",
    "git revert*",
    "git checkout*",
    "git switch*",
    "git stash*",
    "git clean*",
    "git worktree*",
    "git tag*",
    "git apply*",
    "git am*",
    "git branch -D*",
    "git branch -d*",
    "git commit --no-verify*",
    "git commit *--no-verify*",
    "git commit --amend*",
    "git commit *--amend*",
    "*;*",
    "*&&*",
    "*||*",
    "*|*",
  ]) {
    assert.equal(bash[denied], "deny", `${denied} must be denied for sheep`);
  }
  assert.equal(bash["*"], "allow");
});

test("restricts sheepdog to the clean local merge and cherry-pick lifecycle", () => {
  const bash = createAgents().sheepdog.permission.bash;
  for (const allowed of [
    "git merge --ff-only*",
    "git merge --no-ff --no-edit*",
    "git merge --continue",
    "git merge --abort",
    "git merge --quit",
    "git cherry-pick*",
    "git cherry-pick --continue",
    "git cherry-pick --skip",
    "git cherry-pick --abort",
    "git cherry-pick --quit",
    "git commit*",
    "herdr agent prompt*",
  ]) {
    assert.equal(bash[allowed], "allow", `${allowed} must be allowed for sheepdog`);
  }
  for (const denied of [
    "git push*",
    "git pull*",
    "git fetch*",
    "git rebase*",
    "git reset*",
    "git checkout*",
    "git switch*",
    "git commit --no-verify*",
    "git commit * --no-verify*",
    "git commit --amend*",
    "git commit * --amend*",
    "git merge *--no-verify*",
    "git worktree*",
    "herdr worktree remove * --force*",
    "*;*",
  ]) {
    assert.equal(bash[denied], "deny", `${denied} must be denied for sheepdog`);
  }
  const agent = createAgents().sheepdog;
  assert.equal(agent.permission.edit, "deny");
  assert.equal(agent.permission.apply_patch, "deny");
});

test("allows user overrides without dropping default permissions", () => {
  const merged = mergeAgent(createAgents().grazer, {
    model: "example/custom",
    permission: { webfetch: "allow" },
  });
  assert.equal(merged.model, "example/custom");
  assert.equal(merged.permission.webfetch, "allow");
  assert.equal(merged.permission.edit, "deny");
});

test("applies declarative shepherd local overrides", () => {
  const agents = createAgents({
    shepherdPermissions: {
      private_deployment_status: "allow",
    },
    shepherdPromptAppend: "Use private deployment tools when available.",
  });
  assert.equal(agents.shepherd.permission.private_deployment_status, "allow");
  assert.match(agents.shepherd.prompt, /Use private deployment tools when available\.$/);
});

test("maps agents to hook enforcement modes", () => {
  assert.equal(modeForAgent("shepherd"), "shepherd");
  assert.equal(modeForAgent("shepherd-governor"), "governor");
  assert.equal(modeForAgent("sheepdog"), "sheepdog");
  assert.equal(modeForAgent("grazer"), "grazer");
  assert.equal(modeForAgent("sheep"), "sheep");
  assert.equal(modeForAgent("shearer-low"), "shearer");
  assert.equal(modeForAgent("shearer-medium"), "shearer");
  assert.equal(modeForAgent("build"), "none");
  for (const role of OLD_ROLES) {
    assert.equal(modeForAgent(role), "none");
  }
});

test("preserves critical orchestration behavior in the tiered prompts", () => {
  assert.match(SHEPHERD_PROMPT, /installed CLI is authoritative/);
  assert.match(SHEPHERD_PROMPT, /Treat unknown as inconclusive/);
  assert.match(SHEPHERD_PROMPT, /Synthesize worker findings/);
  assert.match(SHEPHERD_PROMPT, /peer sharing the same Git common repository/);
  assert.match(SHEPHERD_PROMPT, /never nest a worker checkout/);
  assert.match(SHEPHERD_PROMPT, /Selecting shepherd-governor is approval/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /peers sharing the same Git common repository/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /never nests a worker checkout/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /dedicated branches and worktrees/);
  assert.match(SHEEPDOG_PROMPT, /read the authoritative plan directly with herdr_plan_read/);
  assert.match(SHEEPDOG_PROMPT, /Before acknowledging any task contract/);
  assert.match(SHEEPDOG_PROMPT, /never rely on a secondhand summary of the plan/);
  assert.match(SHEEPDOG_PROMPT, /Plan artifacts are read-only for you/);
});

test("prompt spawn lists mirror the approved spawn matrix", () => {
  const spawns = (prompt) => [...prompt.matchAll(/--agent (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(spawns(SHEPHERD_PROMPT), ["grazer"]);
  assert.deepEqual(spawns(SHEPHERD_GOVERNOR_PROMPT), ["grazer", "sheepdog"]);
  assert.deepEqual(spawns(SHEEPDOG_PROMPT), ["grazer", "sheep", "shearer-low", "shearer-medium"]);
});

test("separates leaf work from coordinator acknowledgement and milestone replies", () => {
  assert.match(SHEPHERD_PROMPT, /Leaf workers work directly/);
  assert.match(SHEPHERD_PROMPT, /never send an acknowledgement turn/);
  assert.doesNotMatch(SHEPHERD_PROMPT, /\bACK\b/);
  for (const keyword of ["CORRECT", "REPLAN", "STOP"]) {
    assert.match(SHEPHERD_PROMPT, new RegExp(`\\b${keyword} - `));
  }
  assert.match(SHEPHERD_PROMPT, /FINALIZE followed by the findings/);
  assert.doesNotMatch(SHEPHERD_PROMPT, /\bCONTINUE\b/);

  assert.match(SHEPHERD_GOVERNOR_PROMPT, /Sheepdog acknowledges its task contract/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /Leaf workers work directly without an acknowledgement turn/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /FINALIZE closes a task and is never an acknowledgement/);
  for (const keyword of ["ACK", "CONTINUE", "CORRECT", "REPLAN", "STOP", "FINALIZE"]) {
    assert.match(SHEPHERD_GOVERNOR_PROMPT, new RegExp(`\\b${keyword} - `));
  }

  assert.match(SHEEPDOG_PROMPT, /Leaves work directly from their task contracts and never send an acknowledgement turn/);
  assert.match(SHEEPDOG_PROMPT, /FINALIZE closes a task and is never an acknowledgement/);
  assert.match(SHEEPDOG_PROMPT, /acknowledgement keyword: ACK, CORRECT, REPLAN, or STOP/);
  assert.match(SHEEPDOG_PROMPT, /CONTINUE, CORRECT, REPLAN, STOP, or FINALIZE/);

  for (const prompt of [GRAZER_PROMPT, SHEEP_PROMPT, SHEARER_REVIEW_PROMPT]) {
    assert.match(prompt, /do not send an acknowledgement turn/);
    assert.doesNotMatch(prompt, /\bACK\b/);
  }
  assert.match(SHEEP_PROMPT, /CONTINUE, CORRECT, REPLAN, STOP, or FINALIZE/);
  assert.match(GRAZER_PROMPT, /FINALIZE followed by the findings/);
  assert.match(SHEARER_REVIEW_PROMPT, /FINALIZE followed by exactly one verdict/);
});

test("denies Developer steering submission to all seven orchestration roles as defense in depth", () => {
  const agents = createAgents();
  assert.deepEqual([...ORCHESTRATION_ROLES].sort(), [
    "grazer",
    "shearer-low",
    "shearer-medium",
    "sheep",
    "sheepdog",
    "shepherd",
    "shepherd-governor",
  ]);
  assert.equal(DEVELOPER_AGENT, "developer");
  assert.ok(!ORCHESTRATION_ROLES.includes(DEVELOPER_AGENT));
  for (const role of ORCHESTRATION_ROLES) {
    assert.equal(agents[role].permission[STEERING_TOOLS.submit], "deny", `${role} must deny ${STEERING_TOOLS.submit}`);
  }
});

test("keeps steering submission parity between static permissions and runtime allowlist", async () => {
  const tools = createSteeringTools({ cwd: tmpdir() });
  assert.ok(tools[STEERING_TOOLS.submit], `plugin registers ${STEERING_TOOLS.submit}`);
  assert.deepEqual([...STEERING_TOOL_ACCESS.keys()], [STEERING_TOOLS.submit]);
  assert.deepEqual([...STEERING_TOOL_ACCESS.get(STEERING_TOOLS.submit)], [DEVELOPER_AGENT]);
  const agents = createAgents();
  for (const [name, allowed] of STEERING_TOOL_ACCESS) {
    assert.ok(tools[name], `plugin registers ${name}`);
    for (const agent of allowed) {
      assert.ok(!agents[agent], `Developer is not a registered orchestration agent: ${agent}`);
    }
    for (const role of ORCHESTRATION_ROLES) {
      assert.equal(agents[role].permission[name], "deny", `${role} is denied ${name} statically`);
      assert.ok(!allowed.has(role), `${role} is absent from the runtime allowlist`);
    }
  }
});

test("maps Developer to an explicit non-flock mode distinct from none", () => {
  assert.equal(modeForAgent(DEVELOPER_AGENT), "developer");
  assert.equal(modeForAgent("none"), "none");
  assert.equal(modeForAgent("unknown"), "none");
  assert.equal(modeForAgent("ambiguous"), "none");
  assert.equal(modeForAgent(undefined), "none");
  assert.notEqual(modeForAgent(DEVELOPER_AGENT), "none");
});

test("never spawns Developer through any flock spawn matrix", () => {
  const agents = createAgents();
  const pattern = `herdr agent start * --kind opencode --pane * -- --agent ${DEVELOPER_AGENT}`;
  for (const role of ORCHESTRATION_ROLES) {
    assert.equal(agents[role].permission.bash?.[pattern], undefined, `${role} must not spawn ${DEVELOPER_AGENT}`);
  }
});

test("M3 shepherd-only raw steering and ownership tools with explicit worker denials in code", () => {
  const agents = createAgents();
  assert.deepEqual([...SHEPHERD_PHASES].sort(), ["shepherd", "shepherd-governor"]);
  for (const name of Object.values(RAW_STEERING_TOOLS)) {
    assert.equal(agents.shepherd.permission[name], "allow", `shepherd must allow ${name}`);
    assert.equal(agents["shepherd-governor"].permission[name], "allow", `governor must allow ${name}`);
    for (const role of ["sheepdog", "grazer", "sheep", "shearer-low", "shearer-medium"]) {
      assert.equal(agents[role].permission[name], "deny", `${role} must deny ${name} in code`);
    }
  }
  for (const name of Object.values(OWNERSHIP_TOOLS)) {
    assert.equal(agents.shepherd.permission[name], "allow", `shepherd must allow ${name}`);
    assert.equal(agents["shepherd-governor"].permission[name], "allow", `governor must allow ${name}`);
    for (const role of ["sheepdog", "grazer", "sheep", "shearer-low", "shearer-medium"]) {
      assert.equal(agents[role].permission[name], "deny", `${role} must deny ${name} in code`);
    }
  }
  // Sheepdog is explicitly denied every raw steering tool (not only via prompts).
  for (const name of Object.values(RAW_STEERING_TOOLS)) {
    assert.ok(name in agents.sheepdog.permission, `sheepdog permission must list ${name}`);
  }
});

test("M3 keeps raw and ownership parity between static permissions and runtime allowlists", async () => {
  const { createOwnershipTools, createRawSteeringTools } = await import("../src/index.js");
  const { tmpdir } = await import("node:os");
  const rawTools = createRawSteeringTools({ cwd: tmpdir() });
  const ownershipTools = createOwnershipTools({ cwd: tmpdir() });
  for (const [name, allowed] of RAW_STEERING_TOOL_ACCESS) {
    assert.ok(rawTools[name], `plugin registers ${name}`);
    assert.deepEqual([...allowed].sort(), ["shepherd", "shepherd-governor"]);
    for (const role of ORCHESTRATION_ROLES) {
      const expected = allowed.has(role) ? "allow" : "deny";
      assert.equal(createAgents()[role].permission[name], expected, `${role} static ${name} must be ${expected}`);
    }
  }
  for (const [name, allowed] of OWNERSHIP_TOOL_ACCESS) {
    assert.ok(ownershipTools[name], `plugin registers ${name}`);
    assert.deepEqual([...allowed].sort(), ["shepherd", "shepherd-governor"]);
    for (const role of ORCHESTRATION_ROLES) {
      const expected = allowed.has(role) ? "allow" : "deny";
      assert.equal(createAgents()[role].permission[name], expected, `${role} static ${name} must be ${expected}`);
    }
  }
  // Developer remains absent from shepherd tool allowlists.
  for (const allowed of [...RAW_STEERING_TOOL_ACCESS.values(), ...OWNERSHIP_TOOL_ACCESS.values()]) {
    assert.ok(!allowed.has(DEVELOPER_AGENT));
  }
});

test("M3 prompts own raw steering for shepherd phases and deny it for workers", async () => {
  const { SHEPHERD_PROMPT, SHEPHERD_GOVERNOR_PROMPT, SHEEPDOG_PROMPT, GRAZER_PROMPT, SHEEP_PROMPT } = await import("../src/prompts.js");
  assert.match(SHEPHERD_PROMPT, /Only the recorded owner phase/);
  assert.match(SHEPHERD_PROMPT, /NOT AUTHORITATIVE PHASE/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /NOT AUTHORITATIVE PHASE/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /never raw records/);
  assert.match(SHEEPDOG_PROMPT, /never yours to read directly|denied those tools/);
  assert.match(GRAZER_PROMPT, /not yours/);
  assert.match(SHEEP_PROMPT, /not yours/);
});

// --- 21-M1 sheepdog lifecycle (reprompt) ------------------------------------

function m1GlobToRegExp(pattern) {
  let out = "^";
  for (const c of pattern) {
    if (c === "*") out += ".*";
    else if ("+?^${}()|[]\\.".includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`${out}$`);
}

function m1EvaluateBash(bash, command) {
  let result;
  for (const [pattern, decision] of Object.entries(bash)) {
    if (m1GlobToRegExp(pattern).test(command)) result = decision;
  }
  return result ?? "undefined";
}

test("21-M1 sheepdog start plus prompt plus re-prompt plus wait plus get plus read for each owned role", () => {
  const bash = createAgents().sheepdog.permission.bash;
  for (const key of ["herdr agent prompt*", "herdr agent wait*", "herdr agent get*", "herdr agent read*"]) {
    assert.equal(bash[key], "allow", `${key} must stay evaluation-effective for sheepdog`);
  }
  const keys = Object.keys(bash);
  const star = keys.indexOf("*");
  const promptIdx = keys.indexOf("herdr agent prompt*");
  const waitIdx = keys.indexOf("herdr agent wait*");
  const getIdx = keys.indexOf("herdr agent get*");
  const readIdx = keys.indexOf("herdr agent read*");
  const sepIdx = keys.indexOf("*;*");
  assert.ok(star !== -1 && promptIdx > star, "* deny stays fallback first with lifecycle allows after it");
  for (const idx of [waitIdx, getIdx, readIdx]) assert.ok(idx > star, "wait/get/read allow after * deny");
  assert.ok(sepIdx > promptIdx && sepIdx > waitIdx && sepIdx > getIdx && sepIdx > readIdx, "separator denies stay global last");
  assert.equal(bash["*"], "deny");

  for (const role of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(bash[spawnPattern(role)], "allow", `sheepdog must start ${role}`);
    const start = `herdr agent start ${role}_1 --kind opencode --pane pane1 -- --agent ${role}`;
    assert.equal(m1EvaluateBash(bash, start), "allow", `start evaluates allow for ${role}`);
    const prompt = `herdr agent prompt ${role}_1 hello --wait --timeout 1000`;
    assert.equal(m1EvaluateBash(bash, prompt), "allow", `prompt evaluates allow for ${role}`);
    const reprompt = `herdr agent prompt ${role}_1 corrected bounded text --wait --timeout 1000`;
    assert.equal(m1EvaluateBash(bash, reprompt), "allow", `re-prompt same worker evaluates allow for ${role}`);
    assert.equal(m1EvaluateBash(bash, `herdr agent wait ${role}_1 --timeout 1000`), "allow", `wait evaluates allow for ${role}`);
    assert.equal(m1EvaluateBash(bash, `herdr agent get ${role}_1`), "allow", `get evaluates allow for ${role}`);
    assert.equal(m1EvaluateBash(bash, `herdr agent read ${role}_1`), "allow", `read evaluates allow for ${role}`);
  }
  assert.equal(createAgents().sheepdog.permission.herdr_agent_response, "allow", "sheepdog retrieves via herdr_agent_response");
});

test("21-M1 sheepdog separator content safety fails closed with safe prompt rule", () => {
  const bash = createAgents().sheepdog.permission.bash;
  const clean = 'herdr agent prompt sheep_1 bounded task without separators --wait --timeout 1000';
  assert.equal(m1EvaluateBash(bash, clean), "allow", "clean prompt stays allow");
  for (const cmd of [
    'herdr agent prompt sheep_1 "fix; do X" --wait --timeout 1000',
    'herdr agent prompt sheep_1 "a && b" --wait --timeout 1000',
    'herdr agent prompt sheep_1 "a || b" --wait --timeout 1000',
    'herdr agent prompt sheep_1 "a | b" --wait --timeout 1000',
    'herdr agent prompt sheep_1 "a > b" --wait --timeout 1000',
    'herdr agent prompt sheep_1 "a < b" --wait --timeout 1000',
  ]) {
    assert.equal(m1EvaluateBash(bash, cmd), "deny", `separator task text must fail closed: ${cmd}`);
  }
  assert.match(SHEEPDOG_PROMPT, /content-safe/);
  assert.match(SHEEPDOG_PROMPT, /never carry raw separator/);
  assert.match(SHEEPDOG_PROMPT, /fails closed/);
  assert.match(SHEEPDOG_PROMPT, /split or rephrase/);
  assert.match(SHEEPDOG_PROMPT, /re-prompt the same worker/);
  assert.match(SHEEPDOG_PROMPT, /herdr agent wait/);
  assert.match(SHEEPDOG_PROMPT, /herdr agent get plus herdr agent read/);
});

test("21-M1 sheepdog Ctrl-C-only send-keys replacement with honest residual", () => {
  const bash = createAgents().sheepdog.permission.bash;
  assert.equal(bash["herdr agent send-keys*"], "deny", "broad send-keys must be denied for sheepdog");
  for (const key of [
    "herdr agent send-keys * --keys C-c*",
    "herdr agent send-keys * --keys ctrl+c*",
    "herdr agent send-keys * C-c*",
  ]) {
    assert.equal(bash[key], "allow", `${key} must allow Ctrl-C interrupt`);
  }
  const keys = Object.keys(bash);
  assert.ok(keys.indexOf("herdr agent send-keys*") > keys.indexOf("*"), "send-keys deny after * fallback");
  assert.ok(keys.indexOf("herdr agent send-keys * --keys C-c*") > keys.indexOf("herdr agent send-keys*"), "narrow Ctrl-C after broad deny");
  assert.ok(keys.indexOf("*;*") > keys.indexOf("herdr agent send-keys * --keys C-c*"), "separator denies stay global last after Ctrl-C allows");
  assert.equal(m1EvaluateBash(bash, "herdr agent send-keys worker_1 --keys C-c"), "allow");
  assert.equal(m1EvaluateBash(bash, "herdr agent send-keys worker_1 --keys ctrl+c"), "allow");
  assert.equal(m1EvaluateBash(bash, "herdr agent send-keys worker_1 ls"), "deny", "arbitrary typing stays denied");
  assert.equal(m1EvaluateBash(bash, "herdr agent send-keys worker_1 --keys C-c; rm"), "deny", "separator smuggling stays denied");
  assert.match(SHEEPDOG_PROMPT, /Use send-keys only to interrupt a genuinely stuck worker with Ctrl\+C after inspection/);
  assert.match(SHEEPDOG_PROMPT, /Never type implementation commands/);
  assert.match(SHEEPDOG_PROMPT, /never-bypass/);
  assert.match(SHEEPDOG_PROMPT, /cannot prove intent/);
  assert.match(SHEEPDOG_PROMPT, /stays primary/);
});

test("21-M1 sheepdog REWORK same-sheep routing plus re-review independence plus direct denial", () => {
  assert.match(SHEEPDOG_PROMPT, /REWORK returns concrete findings to the responsible sheep for correction and re-review/);
  assert.match(SHEEPDOG_PROMPT, /Give each shearer fresh bounded context/);
  assert.match(SHEEPDOG_PROMPT, /not the worker conversation/);
  assert.match(SHEEPDOG_PROMPT, /After two failed semantic review cycles/);
  assert.match(SHEEPDOG_PROMPT, /escalate to shepherd-governor/);
  const agent = createAgents().sheepdog;
  assert.equal(agent.permission.edit, "deny", "sheepdog never implements directly");
  assert.equal(agent.permission.apply_patch, "deny");
  assert.match(SHEEPDOG_PROMPT, /You must not edit files, apply patches, hand-resolve conflicts/);
  assert.match(SHEEPDOG_PROMPT, /Never hand-edit a conflicted file/);
  assert.match(SHEEPDOG_PROMPT, /never leave a merge or cherry-pick in progress/);
  const bash = agent.permission.bash;
  for (const denied of ["git push*", "git pull*", "git fetch*", "git remote*", "git rebase*", "git reset*", "git checkout*", "git switch*", "git worktree*", "herdr worktree remove * --force*"]) {
    assert.equal(bash[denied], "deny", `${denied} retained as deny for sheepdog`);
  }
  assert.equal(m1EvaluateBash(bash, "git push origin HEAD"), "deny", "push stays denied");
  for (const role of ["sheepdog", "shepherd", "shepherd-governor"]) {
    assert.equal(bash[spawnPattern(role)], undefined, `sheepdog must not spawn ${role}`);
  }
  assert.equal(m1EvaluateBash(bash, "herdr agent start dog2 --kind opencode --pane p1 -- --agent sheepdog"), "deny", "sheepdog spawns sheepdog fails closed");
});

test("21-M1 sheepdog scoped override guard stays scoped and shadows fail closed", () => {
  const agents = createAgents({
    sheepdogPermissions: { private_squad_status: "allow" },
    sheepdogPromptAppend: "Use private squad tools according to local policy.",
  });
  assert.equal(agents.sheepdog.permission.private_squad_status, "allow");
  assert.match(agents.sheepdog.prompt, /Use private squad tools according to local policy\.$/);
  for (const name of ["shepherd", "shepherd-governor", "grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal("private_squad_status" in agents[name].permission, false, `sheepdog tuple must not leak to ${name}`);
    assert.doesNotMatch(agents[name].prompt, /private squad tools/);
  }
  const shepherdScoped = createAgents({
    shepherdPermissions: { private_deployment_status: "allow" },
    shepherdPromptAppend: "Shepherd private note.",
  });
  assert.equal("private_deployment_status" in shepherdScoped.sheepdog.permission, false, "shepherd tuple must not leak to sheepdog");
  assert.doesNotMatch(shepherdScoped.sheepdog.prompt, /Shepherd private note/);
  assert.equal(shepherdScoped.sheepdog.permission.bash["herdr agent prompt*"], "allow", "shepherd tuple preserves sheepdog lifecycle");

  const shadowed = mergeAgent(createAgents().sheepdog, { permission: { bash: { "herdr agent prompt*": "deny" } } });
  assert.equal(shadowed.permission.bash["herdr agent prompt*"], "deny", "local shadowing flips the static entry");
  assert.equal(m1EvaluateBash(shadowed.permission.bash, "herdr agent prompt sheep_1 hello --wait --timeout 1000"), "deny", "shadowed lifecycle fails closed to deny");
  assert.throws(() => createAgents({ sheepdogPromptAppend: 42 }), /sheepdogPromptAppend must be a string/);
  assert.throws(() => createAgents({ shepherdPromptAppend: 42 }), /shepherdPromptAppend must be a string/);
});

// --- 20-M1 responsive wait mechanics -----------------------------------------

test("20-M1 Shepherd plus Sheepdog prompts describe the bounded poll loop", () => {
  const agents = createAgents();
  for (const name of ["shepherd", "shepherd-governor", "sheepdog"]) {
    const prompt = agents[name].prompt;
    assert.match(prompt, /bounded poll loop/, `${name} names the bounded loop`);
    assert.match(prompt, /short interval/, `${name} polls on a short interval`);
    assert.match(prompt, /herdr agent get/, `${name} polls via get`);
    assert.match(prompt, /working means continue/, `${name} working means continue`);
    assert.match(prompt, /idle or done means retrieve/, `${name} settled means retrieve`);
    assert.match(prompt, /herdr_agent_response until complete/, `${name} retrieves until complete`);
    assert.match(prompt, /blocked means inspect/, `${name} blocked means inspect`);
    assert.match(prompt, /never blind input/, `${name} never blind input`);
    assert.match(prompt, /surface immediately with .*distinct structured code/, `${name} early failures stay distinct`);
    assert.match(prompt, /instead of decaying to timeout/, `${name} never decays to timeout`);
    assert.match(prompt, /disappearance.*explicit/, `${name} disappearance gets explicit report`);
    assert.match(prompt, /safety timeout stays the final bound only/, `${name} safety timeout is final bound`);
    assert.match(prompt, /WAIT_TIMEOUT_EXPIRED/, `${name} names the timeout code`);
    assert.match(prompt, /Retries stay bounded/, `${name} retries stay bounded`);
    assert.match(prompt, /Treat unknown as inconclusive/, `${name} keeps unknown inconclusive`);
  }
  assert.match(agents.sheepdog.prompt, /herdr agent wait/, "sheepdog keeps wait as bounded sleep");
  assert.match(agents.sheepdog.prompt, /herdr agent get plus herdr agent read/, "sheepdog keeps get plus read checks");
  assert.match(agents.sheepdog.prompt, /content-safe/, "sheepdog keeps content-safe rule");
  assert.match(agents.shepherd.prompt, /routine flock waits belong to sheepdog/, "shepherd defers routine waits to sheepdog");
  assert.match(agents["shepherd-governor"].prompt, /routine flock waits belong to sheepdog/, "governor defers routine waits to sheepdog");
  assert.match(agents.sheepdog.prompt, /no per-transition Shepherd wakeups/, "sheepdog owns waits without per-transition wakeups");
});

test("20-M1 lifecycle allows stay to already-permitted surfaces with no new commands", () => {
  const agents = createAgents();
  for (const name of ["shepherd", "shepherd-governor", "sheepdog"]) {
    const bash = agents[name].permission.bash;
    for (const key of ["herdr agent prompt*", "herdr agent wait*", "herdr agent get*", "herdr agent read*", "herdr agent list*"]) {
      assert.equal(bash[key], "allow", `${name} keeps ${key} for bounded polling`);
    }
    for (const invented of [
      "herdr events*",
      "herdr agent events*",
      "herdr agent logs*",
      "herdr agent stream*",
      "herdr agent tail*",
      "herdr event*",
    ]) {
      assert.equal(bash[invented], undefined, `${name} must not invent ${invented}`);
      assert.equal(m1EvaluateBash(bash, invented.replace("*", " squad_1")), "deny", `${invented} stays denied for ${name}`);
    }
  }
  const governorBash = agents["shepherd-governor"].permission.bash;
  assert.equal(governorBash[spawnPattern("sheep")], undefined, "governor leaf spawn ban untouched");
  assert.equal(governorBash[spawnPattern("shearer-low")], undefined, "governor shearer ban untouched");
  assert.match(agents["shepherd-governor"].prompt, /Never prompt.*sheep/, "governor leaf prompt ban untouched");
  for (const role of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(agents.sheepdog.permission.bash[spawnPattern(role)], "allow", `sheepdog keeps owned ${role} waits`);
  }
});

test("20-M1 Sheepdog owns routine flock handling with unknown inconclusive preserved", () => {
  const agents = createAgents();
  assert.match(agents.sheepdog.prompt, /You own routine flock waits/, "sheepdog owns routine waits");
  assert.match(agents.sheepdog.prompt, /You own leaf retries/, "sheepdog keeps leaf retries");
  assert.match(agents.shepherd.prompt, /no per-transition Shepherd wakeups/, "shepherd has no per-transition wakeups");
  assert.match(agents["shepherd-governor"].prompt, /never wait on sheep or shearer/, "governor never waits on leaves directly");
  for (const prompt of [agents.shepherd.prompt, agents["shepherd-governor"].prompt, agents.sheepdog.prompt]) {
    assert.match(prompt, /unknown as inconclusive/, "unknown stays inconclusive in every wait loop");
    assert.doesNotMatch(prompt, /herdr agent events/, "no stream invented in prompts");
    assert.doesNotMatch(prompt, /herdr agent logs/, "no log stream invented in prompts");
  }
});
