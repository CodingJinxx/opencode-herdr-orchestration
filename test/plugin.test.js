import test from "node:test";
import assert from "node:assert/strict";

import plugin from "../src/index.js";
import * as packageEntry from "../src/plugin.js";

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
    sheepdogModel: "custom/sheepdog",
    sheepdogVariant: "medium",
    reviewerModel: "custom/reviewer",
  });
  const config = {};
  hooks.config(config);
  assert.equal(config.agent.shepherd.model, "custom/shepherd");
  assert.equal(config.agent["shepherd-governor"].model, "custom/shepherd");
  assert.equal(config.agent.grazer.model, "custom/worker");
  assert.equal(config.agent.grazer.variant, "high");
  assert.equal(config.agent.sheep.model, "custom/worker");
  assert.equal(config.agent.sheep.variant, "high");
  assert.equal(config.agent.sheepdog.model, "custom/sheepdog");
  assert.equal(config.agent.sheepdog.variant, "medium");
  assert.equal(config.agent["shearer-low"].model, "custom/reviewer");
  assert.equal(config.agent["shearer-medium"].model, "custom/reviewer");
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
