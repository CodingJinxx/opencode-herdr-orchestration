import test from "node:test";
import assert from "node:assert/strict";

import { createAgents, mergeAgent } from "../src/agents.js";
import { modeForAgent } from "../src/index.js";
import { SHEEPDOG_PROMPT, SHEEP_PROMPT, SHEPHERD_GOVERNOR_PROMPT, SHEPHERD_PROMPT } from "../src/prompts.js";

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

test("pins shearer variants to GPT-5.6 Terra", () => {
  const agents = createAgents();
  assert.equal(agents["shearer-low"].model, "litellm-responses/gpt-5.6-terra");
  assert.equal(agents["shearer-low"].variant, "low");
  assert.equal(agents["shearer-medium"].model, "litellm-responses/gpt-5.6-terra");
  assert.equal(agents["shearer-medium"].variant, "medium");
});

test("governor is the execution authority on the shepherd model, not a reviewer", () => {
  const agents = createAgents({ shepherdModel: "custom/shepherd" });
  const governor = agents["shepherd-governor"];
  assert.equal(governor.model, "custom/shepherd");
  assert.equal(governor.permission.edit["**/*.md"], "allow");
  const bash = governor.permission.bash;
  assert.equal(bash["git push*"], "allow");
  assert.equal(bash["git merge*"], "allow");
  assert.equal(bash["gh pr create*"], "allow");
  assert.equal(bash["git push --force*"], "deny");
  assert.equal(bash["*"], "deny");
  assert.match(governor.prompt, /You are not a reviewer/);
  assert.match(governor.prompt, /never perform semantic review yourself/);
  assert.doesNotMatch(governor.prompt, /exactly one verdict/);
  assert.match(governor.prompt, /final delivery/);
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
    "git merge *--no-verify*",
    "git worktree*",
    "herdr worktree create*",
    "herdr worktree remove*",
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
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /never nest a worker checkout/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /You are not a reviewer/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /dedicated branches and worktrees/);
  assert.match(SHEEPDOG_PROMPT, /own prepared branch and worktree with non-overlapping ownership/);
});

test("prompt spawn lists mirror the approved spawn matrix", () => {
  const spawns = (prompt) => [...prompt.matchAll(/--agent (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(spawns(SHEPHERD_PROMPT), ["grazer"]);
  assert.deepEqual(spawns(SHEPHERD_GOVERNOR_PROMPT), ["grazer", "sheepdog"]);
  assert.deepEqual(spawns(SHEEPDOG_PROMPT), ["grazer", "sheep", "shearer-low", "shearer-medium"]);
});

test("separates acknowledgement replies from post-milestone replies", () => {
  assert.match(SHEPHERD_PROMPT, /acknowledgement reply/);
  assert.match(SHEPHERD_PROMPT, /post-milestone reply/);
  assert.match(SHEPHERD_PROMPT, /ACK confirms receipt only and is never milestone progress/);
  assert.match(SHEPHERD_PROMPT, /FINALIZE closes a task and is never an acknowledgement/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /FINALIZE closes a task and is never an acknowledgement/);
  assert.match(SHEEPDOG_PROMPT, /FINALIZE closes a task and is never an acknowledgement/);
  for (const keyword of ["ACK", "CONTINUE", "CORRECT", "REPLAN", "STOP", "FINALIZE"]) {
    assert.match(SHEPHERD_PROMPT, new RegExp(`\\b${keyword} - `));
    assert.match(SHEPHERD_GOVERNOR_PROMPT, new RegExp(`\\b${keyword} - `));
  }
  for (const prompt of [SHEEP_PROMPT, SHEEPDOG_PROMPT]) {
    assert.match(prompt, /acknowledgement keyword: ACK, CORRECT, REPLAN, or STOP/);
    assert.match(prompt, /CONTINUE, CORRECT, REPLAN, STOP, or FINALIZE/);
  }
});
