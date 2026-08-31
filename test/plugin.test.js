import test from "node:test";
import assert from "node:assert/strict";

import plugin from "../src/index.js";

test("registers agents and injects per-session modes", async () => {
  const hooks = await plugin({}, {});
  assert.ok(hooks.tool.herdr_agent_response);
  const config = { agent: { "sheep-plan": { model: "custom/worker" } } };
  hooks.config(config);
  assert.equal(config.agent["sheep-plan"].model, "custom/worker");
  assert.ok(config.agent["shepherd-build"]);

  await hooks["chat.message"]({ sessionID: "plan-session", agent: "shepherd-plan" });
  await hooks["chat.message"]({ sessionID: "build-session", agent: "shepherd-build" });

  const planOutput = { env: {} };
  const buildOutput = { env: {} };
  const unknownOutput = { env: {} };
  await hooks["shell.env"]({ sessionID: "plan-session", cwd: "C:/repo" }, planOutput);
  await hooks["shell.env"]({ sessionID: "build-session", cwd: "C:/repo" }, buildOutput);
  await hooks["shell.env"]({ sessionID: "other", cwd: "C:/repo" }, unknownOutput);
  assert.equal(planOutput.env.SHEPHERD_MODE, "plan");
  assert.equal(buildOutput.env.SHEPHERD_MODE, "build");
  assert.equal(unknownOutput.env.SHEPHERD_MODE, "none");
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
            agent: "sheep-build",
            finish: "stop",
            time: { completed: 2 },
          },
          parts: [{ type: "text", text: "completed work" }],
        },
      ],
    });
  };
  const hooks = await plugin({}, { response: { run, secret: Buffer.alloc(32, 9) } });
  let metadata;
  const output = await hooks.tool.herdr_agent_response.execute(
    { target: "worker_1" },
    {
      agent: "shepherd-build",
      abort: new AbortController().signal,
      metadata(value) {
        metadata = value;
      },
    },
  );
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.text, "completed work");
  assert.equal(metadata.metadata.messageID, "a1");
});
