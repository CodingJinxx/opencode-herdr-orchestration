import test from "node:test";
import assert from "node:assert/strict";

import plugin from "../src/index.js";

test("registers agents and injects per-session modes", async () => {
  const hooks = await plugin({}, {});
  const config = { agent: { "sheep-plan": { model: "custom/worker" } } };
  hooks.config(config);
  assert.equal(config.agent["sheep-plan"].model, "custom/worker");
  assert.ok(config.agent["sheperd-build"]);

  await hooks["chat.message"]({ sessionID: "plan-session", agent: "sheperd-plan" });
  await hooks["chat.message"]({ sessionID: "build-session", agent: "sheperd-build" });

  const planOutput = { env: {} };
  const buildOutput = { env: {} };
  const unknownOutput = { env: {} };
  await hooks["shell.env"]({ sessionID: "plan-session", cwd: "C:/repo" }, planOutput);
  await hooks["shell.env"]({ sessionID: "build-session", cwd: "C:/repo" }, buildOutput);
  await hooks["shell.env"]({ sessionID: "other", cwd: "C:/repo" }, unknownOutput);
  assert.equal(planOutput.env.SHEPERD_MODE, "plan");
  assert.equal(buildOutput.env.SHEPERD_MODE, "build");
  assert.equal(unknownOutput.env.SHEPERD_MODE, "none");
});
