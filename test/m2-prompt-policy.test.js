import test from "node:test";
import assert from "node:assert/strict";

import { createAgents } from "../src/agents.js";
import { RESPONSE_MATRIX } from "../src/response.js";
import {
  GOVERNOR_PANE_OWNERSHIP_PARAGRAPH,
  GRAZER_PROMPT,
  PANE_CAP,
  PANE_POLICY_SHARED_PARAGRAPH,
  PANE_POLICY_SHARED_SENTENCES,
  SHEEP_PROMPT,
  SHEEPDOG_PANE_OWNERSHIP_PARAGRAPH,
  SHEEPDOG_PROMPT,
  SHEARER_REVIEW_PROMPT,
  SHEPHERD_GOVERNOR_PROMPT,
  SHEPHERD_PANE_OWNERSHIP_PARAGRAPH,
  SHEPHERD_PROMPT,
} from "../src/prompts.js";

function spawnList(prompt) {
  return [...prompt.matchAll(/--agent (\S+)/g)].map((match) => match[1]);
}

test("14-18-M2 every spawning role carries every shared normative sentence", () => {
  assert.ok(Array.isArray(PANE_POLICY_SHARED_SENTENCES));
  assert.ok(PANE_POLICY_SHARED_SENTENCES.length >= 10);
  for (const sentence of PANE_POLICY_SHARED_SENTENCES) {
    assert.equal(typeof sentence, "string");
    assert.ok(sentence.length > 10);
    for (const [name, prompt] of [
      ["shepherd", SHEPHERD_PROMPT],
      ["shepherd-governor", SHEPHERD_GOVERNOR_PROMPT],
      ["sheepdog", SHEEPDOG_PROMPT],
    ]) {
      assert.ok(prompt.includes(sentence), `${name} must contain shared sentence: ${sentence}`);
    }
  }
});

test("14-18-M2 shared paragraph present verbatim in every spawning prompt", () => {
  assert.ok(typeof PANE_POLICY_SHARED_PARAGRAPH === "string");
  assert.ok(PANE_POLICY_SHARED_PARAGRAPH.includes("at most four panes per tab"));
  for (const [name, prompt] of [
    ["shepherd", SHEPHERD_PROMPT],
    ["shepherd-governor", SHEPHERD_GOVERNOR_PROMPT],
    ["sheepdog", SHEEPDOG_PROMPT],
  ]) {
    assert.ok(prompt.includes(PANE_POLICY_SHARED_PARAGRAPH), `${name} must contain the shared paragraph verbatim`);
  }
});

test("14-18-M2 role-specific ownership plus capacity plus grouping plus startup differs per role", () => {
  assert.ok(SHEPHERD_PROMPT.includes(SHEPHERD_PANE_OWNERSHIP_PARAGRAPH));
  assert.ok(SHEPHERD_PROMPT.includes("shepherd manages its single Sheepdog pane scan plus placement plus rename only"));
  assert.ok(SHEPHERD_PROMPT.includes("starts its grazer in a sibling pane of the current tab"));

  assert.ok(SHEPHERD_GOVERNOR_PROMPT.includes(GOVERNOR_PANE_OWNERSHIP_PARAGRAPH));
  assert.ok(SHEPHERD_GOVERNOR_PROMPT.includes("shepherd-governor manages its single Sheepdog pane scan plus placement plus rename only"));
  assert.ok(SHEPHERD_GOVERNOR_PROMPT.includes("starts its sheepdog in a dedicated sibling Sheepdog pane of the current tab"));

  assert.ok(SHEEPDOG_PROMPT.includes(SHEEPDOG_PANE_OWNERSHIP_PARAGRAPH));
  assert.ok(SHEEPDOG_PROMPT.includes("sheepdog manages flock panes scan plus placement plus rename plus close up to the cap"));
  assert.ok(SHEEPDOG_PROMPT.includes("only the creator may rename plus close its panes"));
  assert.ok(SHEEPDOG_PROMPT.includes("startup destinations for grazer plus sheep plus shearer-low plus shearer-medium worker categories stay within the four-pane cap"));
  assert.ok(SHEEPDOG_PROMPT.includes("six-step placement is single-tab plus reuse-first plus evidence-only"));

  assert.ok(!SHEPHERD_PROMPT.includes(GOVERNOR_PANE_OWNERSHIP_PARAGRAPH));
  assert.ok(!SHEPHERD_PROMPT.includes(SHEEPDOG_PANE_OWNERSHIP_PARAGRAPH));
  assert.ok(!SHEPHERD_GOVERNOR_PROMPT.includes(SHEPHERD_PANE_OWNERSHIP_PARAGRAPH));
  assert.ok(!SHEPHERD_GOVERNOR_PROMPT.includes(SHEEPDOG_PANE_OWNERSHIP_PARAGRAPH));
  assert.ok(!SHEEPDOG_PROMPT.includes(SHEPHERD_PANE_OWNERSHIP_PARAGRAPH));
  assert.ok(!SHEEPDOG_PROMPT.includes(GOVERNOR_PANE_OWNERSHIP_PARAGRAPH));
});

test("14-18-M2 leaves stay unchanged with no pane policy", () => {
  for (const [name, prompt] of [
    ["grazer", GRAZER_PROMPT],
    ["sheep", SHEEP_PROMPT],
    ["shearer", SHEARER_REVIEW_PROMPT],
  ]) {
    assert.ok(!prompt.includes(PANE_POLICY_SHARED_PARAGRAPH), `${name} must not contain the shared pane paragraph`);
    for (const sentence of PANE_POLICY_SHARED_SENTENCES) {
      assert.ok(!prompt.includes(sentence), `${name} must not contain shared sentence: ${sentence}`);
    }
    assert.ok(!prompt.includes("manages its single Sheepdog pane"));
    assert.ok(!prompt.includes("manages flock panes"));
  }
});

test("14-18-M2 prompts carry the normative pane wording from shared source exports", () => {
  for (const fragment of [
    "at most four panes per tab",
    "use indexed overflow instead",
    "tabs keep their existing labels",
    "Reuse the matching pane when found",
    "Never derive IDs from sidebar order or examples",
    "excluded from every scan plus split plus placement plus rename plus close plus reuse",
    "Never count it toward the four-pane cap",
    "Never create a workspace or tab to evade the cap",
    "never rely on another client focused pane",
    "reuse the current pane via --pane plus --current",
  ]) {
    assert.ok(PANE_POLICY_SHARED_PARAGRAPH.includes(fragment), `shared pane paragraph must contain: ${fragment}`);
  }
  for (const sentence of PANE_POLICY_SHARED_SENTENCES) {
    assert.ok(
      SHEPHERD_PROMPT.includes(sentence) &&
        SHEPHERD_GOVERNOR_PROMPT.includes(sentence) &&
        SHEEPDOG_PROMPT.includes(sentence),
      `spawning prompts must pin shared sentence verbatim: ${sentence}`,
    );
  }
  assert.ok(SHEPHERD_PROMPT.includes(PANE_POLICY_SHARED_PARAGRAPH.slice(0, 80)));
});

test("14-18-M2 spawn plus response plus state matrices intact with no new spawn targets", () => {
  const agents = createAgents();
  function pattern(role) {
    return `herdr agent start * --kind opencode --pane * -- --agent ${role}`;
  }
  assert.equal(agents.shepherd.permission.bash[pattern("grazer")], "allow");
  for (const role of ["sheep", "sheepdog", "shearer-low", "shearer-medium", "shepherd", "shepherd-governor", "developer"]) {
    assert.equal(agents.shepherd.permission.bash[pattern(role)], undefined, `shepherd must not spawn ${role}`);
  }
  for (const role of ["grazer", "sheepdog"]) {
    assert.equal(agents["shepherd-governor"].permission.bash[pattern(role)], "allow");
  }
  for (const role of ["sheep", "shearer-low", "shearer-medium", "shepherd", "shepherd-governor", "developer"]) {
    assert.equal(agents["shepherd-governor"].permission.bash[pattern(role)], undefined, `governor must not spawn ${role}`);
  }
  for (const role of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(agents.sheepdog.permission.bash[pattern(role)], "allow");
  }
  for (const role of ["shepherd", "shepherd-governor", "developer"]) {
    assert.equal(agents.sheepdog.permission.bash[pattern(role)], undefined, `sheepdog must not spawn ${role}`);
  }
  assert.deepEqual(RESPONSE_MATRIX.get("shepherd"), new Set(["grazer"]));
  assert.deepEqual(RESPONSE_MATRIX.get("shepherd-governor"), new Set(["grazer", "sheepdog"]));
  assert.deepEqual(
    RESPONSE_MATRIX.get("sheepdog"),
    new Set(["grazer", "sheep", "shearer-low", "shearer-medium"]),
  );
  assert.equal(PANE_CAP, 4);
});

test("14-18-M2 prompt additions keep spawn lists plus acknowledgement controls intact", () => {
  assert.deepEqual(spawnList(SHEPHERD_PROMPT), ["grazer"]);
  assert.deepEqual(spawnList(SHEPHERD_GOVERNOR_PROMPT), ["grazer", "sheepdog"]);
  assert.deepEqual(spawnList(SHEEPDOG_PROMPT), ["grazer", "sheep", "shearer-low", "shearer-medium"]);
  assert.doesNotMatch(SHEPHERD_PROMPT, /\bACK\b/);
  assert.doesNotMatch(SHEPHERD_PROMPT, /\bCONTINUE\b/);
  for (const keyword of ["CORRECT", "REPLAN", "STOP"]) {
    assert.match(SHEPHERD_PROMPT, new RegExp(`\\b${keyword}\\b`));
  }
  assert.match(SHEPHERD_PROMPT, /FINALIZE/);
});
