import test from "node:test";
import assert from "node:assert/strict";

import { createAgents, mergeAgent } from "../src/agents.js";
import { modeForAgent } from "../src/index.js";
import { SHEPHERD_BUILD_PROMPT, SHEPHERD_PLAN_PROMPT } from "../src/prompts.js";

test("registers the closed agent topology", () => {
  const agents = createAgents();
  assert.deepEqual(Object.keys(agents).sort(), [
    "shearer-review-low",
    "shearer-review-medium",
    "sheep-build",
    "sheep-plan",
    "shepherd-build",
    "shepherd-plan",
  ]);
});

test("pins reviewer variants to GPT-5.6 Terra", () => {
  const agents = createAgents();
  assert.equal(agents["shearer-review-low"].model, "litellm-responses/gpt-5.6-terra");
  assert.equal(agents["shearer-review-low"].variant, "low");
  assert.equal(agents["shearer-review-medium"].model, "litellm-responses/gpt-5.6-terra");
  assert.equal(agents["shearer-review-medium"].variant, "medium");
});

test("limits shepherd-plan and shepherd-build worker launches", () => {
  const agents = createAgents();
  const planBash = agents["shepherd-plan"].permission.bash;
  const buildBash = agents["shepherd-build"].permission.bash;
  assert.equal(planBash["herdr agent start * --kind opencode --pane * -- --agent sheep-plan"], "allow");
  assert.equal(planBash["herdr agent start * --kind opencode --pane * -- --agent sheep-build"], undefined);
  assert.equal(agents["shepherd-plan"].permission.herdr_agent_response, "allow");
  assert.equal(buildBash["herdr agent start * --kind opencode --pane * -- --agent sheep-plan"], "allow");
  assert.equal(buildBash["herdr agent start * --kind opencode --pane * -- --agent sheep-build"], "allow");
  assert.equal(buildBash["herdr agent start * --kind opencode --pane * -- --agent shearer-review-low"], "allow");
  assert.equal(buildBash["herdr agent start * --kind opencode --pane * -- --agent shearer-review-medium"], "allow");
  assert.equal(buildBash["herdr worktree create *"], "allow");
  assert.equal(buildBash["herdr worktree remove * --force*"], "deny");
});

test("keeps workers and reviewers as leaves with intended Git authority", () => {
  const agents = createAgents();
  assert.equal(agents["sheep-plan"].permission.task, "deny");
  assert.equal(agents["sheep-plan"].permission.edit, "deny");
  assert.equal(agents["sheep-plan"].permission.bash["rg *"], undefined);
  assert.equal(agents["sheep-plan"].permission.herdr_agent_response, "deny");
  assert.equal(agents["sheep-build"].permission.task, "deny");
  assert.equal(agents["sheep-build"].permission.bash["git push*"], "deny");
  assert.equal(agents["sheep-build"].permission.bash["git merge*"], "deny");
  assert.equal(agents["sheep-build"].permission.bash["git *;*"], "deny");
  assert.equal(agents["sheep-build"].permission.herdr_agent_response, "deny");
  for (const name of ["shearer-review-low", "shearer-review-medium"]) {
    assert.equal(agents[name].permission.edit, "deny");
    assert.equal(agents[name].permission.task, "deny");
    assert.equal(agents[name].permission.herdr_agent_response, "deny");
    assert.equal(agents[name].permission.bash["*"], "deny");
  }
});

test("allows user overrides without dropping default permissions", () => {
  const merged = mergeAgent(createAgents()["sheep-plan"], {
    model: "example/custom",
    permission: { webfetch: "allow" },
  });
  assert.equal(merged.model, "example/custom");
  assert.equal(merged.permission.webfetch, "allow");
  assert.equal(merged.permission.edit, "deny");
});

test("applies declarative shepherd-build local overrides", () => {
  const agents = createAgents({
    shepherdBuildPermissions: {
      private_deployment_status: "allow",
    },
    shepherdBuildPromptAppend: "Use private deployment tools when available.",
  });
  assert.equal(agents["shepherd-build"].permission.private_deployment_status, "allow");
  assert.match(agents["shepherd-build"].prompt, /Use private deployment tools when available\.$/);
});

test("maps agents to hook enforcement modes", () => {
  assert.equal(modeForAgent("shepherd-plan"), "plan");
  assert.equal(modeForAgent("shepherd-build"), "build");
  assert.equal(modeForAgent("sheep-plan"), "sheep-plan");
  assert.equal(modeForAgent("sheep-build"), "sheep-build");
  assert.equal(modeForAgent("shearer-review-medium"), "review");
  assert.equal(modeForAgent("build"), "none");
});

test("preserves critical orchestration behavior from standalone prompts", () => {
  assert.match(SHEPHERD_PLAN_PROMPT, /installed CLI is authoritative/);
  assert.match(SHEPHERD_PLAN_PROMPT, /Treat unknown as inconclusive/);
  assert.match(SHEPHERD_PLAN_PROMPT, /Synthesize worker findings/);
  assert.match(SHEPHERD_PLAN_PROMPT, /peer that shares the same Git common repository/);
  assert.match(SHEPHERD_BUILD_PROMPT, /dedicated branch and worktree/);
  assert.match(SHEPHERD_BUILD_PROMPT, /never nest a worker checkout/);
});
