import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "jsonc-parser";

import {
  AGENT_NAMES,
  PROJECT_CONFIG_FILE,
  configDirectory,
  findConfigFile,
  findProjectConfigFile,
  resolveProjectConfigFile,
  updateProjectAgentPermissions,
  writeProjectAgentPermissions,
} from "../src/installer.js";
import {
  GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH,
  SHEPHERD_GOVERNOR_PROMPT,
} from "../src/prompts.js";
import { createAgents } from "../src/agents.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function disposableRepo(prefix = "orchestration-project-e2e-") {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "notes.md"), "# disposable\n\nUnrelated work.\n", "utf8");
  git(cwd, "add", "notes.md");
  git(cwd, "commit", "-m", "initial", "-q");
  return cwd;
}

function isUnderTemp(value) {
  const temp = resolve(tmpdir());
  const target = resolve(value);
  return target === temp || target.startsWith(temp);
}

// Human instruction -> skill application -> git diff inspectable change ->
// debug config effective confirmation, fixtures confined to temp plus project
// roots only. No global writes anywhere.
test("15-M2 E2E disposable repo proves human instruction to skill application to git diff to debug config", () => {
  const projectRoot = disposableRepo();
  assert.ok(isUnderTemp(projectRoot), "disposable fixture must stay in OS temp");

  // Supply: the human Developer supplies the exact trigger. Only the human
  // may invoke the skill; nothing else auto-invokes it.
  const humanInstruction = "govern project permissions";
  assert.equal(`"${humanInstruction}"`, '"govern project permissions"');
  assert.ok(SHEPHERD_GOVERNOR_PROMPT.includes('"govern project permissions"'));
  assert.ok(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH.includes("only the human Developer may invoke it"));

  // File location: a fresh project defaults to opencode.json in the project
  // root; confinement stays fail-closed inside the project root.
  const expected = join(resolve(projectRoot), PROJECT_CONFIG_FILE);
  assert.equal(findProjectConfigFile(projectRoot), expected);
  assert.equal(resolveProjectConfigFile(projectRoot), expected);

  // Seed unrelated project content to prove merge preservation: a comment,
  // an unrelated plugin entry, and an existing shepherd rule.
  const seed = `{
  // Keep this E2E comment.
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["other-plugin"],
  "agent": {
    "shepherd": { "permission": { "bash": { "git status*": "allow" } } }
  }
}
`;
  writeFileSync(join(projectRoot, "opencode.json"), seed, "utf8");
  git(projectRoot, "add", "opencode.json");
  git(projectRoot, "commit", "-m", "seed project config", "-q");

  // Invoke: apply the governor skill explicitly for one bounded widening.
  // Helpers target agent.<name>.permission blocks as text with set semantics
  // and idempotent reapply via parse plus modify plus applyEdits.
  const applied = writeProjectAgentPermissions(projectRoot, "sheepdog", {
    bash: { "echo e2e-probe-*": "allow" },
  });
  assert.equal(applied.file, expected);
  assert.equal(applied.changed, true);
  assert.ok(isUnderTemp(applied.file), "project write must stay in temp project root");
  const globalDir = resolve(configDirectory());
  assert.ok(!resolve(applied.file).startsWith(globalDir), "project write must never land in global config");

  // Inspect: every project config change is inspectable with git diff before
  // accepting it; unrelated work stays preserved.
  const status = git(projectRoot, "status", "--porcelain");
  assert.match(status, /opencode\.json/);
  const diff = git(projectRoot, "diff", "--", "opencode.json");
  assert.match(diff, /echo e2e-probe-/);
  const stat = git(projectRoot, "diff", "--stat", "--", "opencode.json");
  assert.match(stat, /opencode\.json/);
  const text = readFileSync(expected, "utf8");
  assert.match(text, /Keep this E2E comment/);
  assert.match(text, /other-plugin/);
  const parsed = parse(text, [], { allowTrailingComma: true });
  assert.equal(parsed.plugin[0], "other-plugin");
  assert.equal(parsed.agent.shepherd.permission.bash["git status*"], "allow");
  assert.equal(parsed.agent.sheepdog.permission.bash["echo e2e-probe-*"], "allow");
  // Unrelated tracked work is untouched: only the project file changed.
  const names = git(projectRoot, "diff", "--name-only", "--", ".").split("\n").filter(Boolean);
  assert.deepEqual(names, ["opencode.json"]);

  // Inspection method: verify the merged view the way `opencode debug config`
  // shows it — project agent rules take precedence per-key while unrelated
  // plugin keys stay preserved. A conflicting project deny would override a
  // plugin allow; here the probe allow coexists with base allows.
  const base = createAgents().sheepdog.permission.bash;
  assert.equal(base["herdr agent prompt*"], "allow");
  const merged = { ...base, ...parsed.agent.sheepdog.permission.bash };
  assert.equal(merged["herdr agent prompt*"], "allow");
  assert.equal(merged["echo e2e-probe-*"], "allow");
  const conflicting = updateProjectAgentPermissions(text, "sheepdog", {
    bash: { "herdr agent prompt*": "deny" },
  });
  assert.equal(parse(conflicting).agent.sheepdog.permission.bash["herdr agent prompt*"], "deny");

  // Debug config effective confirmation: the project file is valid JSONC, so
  // `opencode debug config` in the project would show scope local with the
  // probe key; invalid JSON would fail with not valid JSON(C) and the disable
  // flag would show global-only. Reapplying the same update is idempotent.
  assert.doesNotThrow(() => parse(text, [], { allowTrailingComma: true }));
  assert.throws(() => updateProjectAgentPermissions("{ not json", "sheepdog", { bash: "allow" }), /Invalid OpenCode JSONC/);
  const reapplied = updateProjectAgentPermissions(text, "sheepdog", { bash: { "echo e2e-probe-*": "allow" } });
  assert.equal(reapplied, text);
  const idempotent = writeProjectAgentPermissions(projectRoot, "sheepdog", { bash: { "echo e2e-probe-*": "allow" } });
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.backup, null);

  // Restart requirement: config loads at startup, so quit and restart
  // OpenCode intentionally when ready; re-reading the file simulates the
  // post-restart merged view.
  const reread = readFileSync(expected, "utf8");
  assert.equal(reread, text);
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /restart OpenCode intentionally/);
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /opencode debug config/);
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /OPENCODE_DISABLE_PROJECT_CONFIG=1/);

  // Authority boundary: no global side effects from the whole chain.
  const globalFile = resolve(findConfigFile(globalDir));
  if (existsSync(globalFile)) {
    const globalText = readFileSync(globalFile, "utf8");
    assert.ok(!globalText.includes("echo e2e-probe-"), "global config must never gain the project probe");
  }
});

test("15-M2 E2E existing opencode.jsonc layer is preserved with global-only fallback on failure", () => {
  const projectRoot = disposableRepo("orchestration-project-e2e-jsonc-");
  assert.ok(isUnderTemp(projectRoot), "disposable fixture must stay in OS temp");

  // When opencode.jsonc already exists it loads as a separate local layer;
  // helpers edit only the found file and preserve the other.
  const jsoncPath = join(projectRoot, "opencode.jsonc");
  writeFileSync(jsoncPath, `{\n  // Keep this jsonc comment.\n  "plugin": ["other-plugin"]\n}\n`, "utf8");
  assert.equal(findProjectConfigFile(projectRoot), join(resolve(projectRoot), "opencode.jsonc"));
  const written = writeProjectAgentPermissions(projectRoot, "grazer", { skill: "ask" });
  assert.equal(written.file, join(resolve(projectRoot), "opencode.jsonc"));
  assert.equal(existsSync(join(projectRoot, "opencode.json")), false);
  const jsoncText = readFileSync(jsoncPath, "utf8");
  assert.match(jsoncText, /Keep this jsonc comment/);
  assert.match(jsoncText, /other-plugin/);
  assert.equal(parse(jsoncText).agent.grazer.permission.skill, "ask");

  // Git diff stays inspectable for the jsonc layer as well.
  git(projectRoot, "add", "opencode.jsonc");
  const staged = git(projectRoot, "diff", "--cached", "--", "opencode.jsonc");
  assert.match(staged, /grazer/);
  git(projectRoot, "commit", "-m", "seed jsonc", "-q");
  const second = writeProjectAgentPermissions(projectRoot, "grazer", { skill: "deny" });
  assert.equal(second.changed, true);
  assert.ok(second.backup && existsSync(second.backup));
  const unstaged = git(projectRoot, "diff", "--", "opencode.jsonc");
  assert.match(unstaged, /deny/);

  // On failure fix or remove the project file then confirm global-only with
  // the disable flag before restarting intentionally.
  writeFileSync(jsoncPath, "{ not json", "utf8");
  assert.throws(() => updateProjectAgentPermissions(readFileSync(jsoncPath, "utf8"), "grazer", { skill: "allow" }), /Invalid OpenCode JSONC/);
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /fix or remove the project file/);
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /confirm global-only/);
});

test("15-M2 supply plus invoke plus inspect plus location plus merge plus method plus restart workflow from source", () => {
  for (const fragment of [
    '"govern project permissions"',
    "opencode.json",
    "per-key",
    "opencode debug config",
    "restart OpenCode intentionally",
    "denials never invoke",
    "sole supervisor of leaves",
    "spawn plus response plus state matrices",
  ]) {
    assert.ok(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH.includes(fragment), `skill paragraph must contain ${fragment}`);
  }
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /never touch global config/i);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /steering never authorizes/i);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /existing approvals still apply/i);
  const agents = createAgents();
  assert.equal(agents["shepherd-governor"].permission.bash["herdr agent start * --kind opencode --pane * -- --agent grazer"], "allow");
  assert.equal(agents["shepherd-governor"].permission.bash["herdr agent start * --kind opencode --pane * -- --agent sheepdog"], "allow");
});

test("15-M2 E2E all seven roles apply through the skill with preserved tuples", () => {
  const projectRoot = disposableRepo("orchestration-project-e2e-roles-");
  let text = "{}";
  for (const role of AGENT_NAMES) {
    text = updateProjectAgentPermissions(text, role, { bash: { "echo e2e-seven-*": "allow" } });
  }
  const parsed = parse(text);
  for (const role of ["shepherd", "shepherd-governor", "sheepdog", "grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(parsed.agent[role].permission.bash["echo e2e-seven-*"], "allow", `${role} must gain the probe rule`);
  }
  // Tuple shape is preserved through the text edits.
  const entry = "file:///tmp/node_modules/@ia-forge/flocky/src/plugin.js";
  const withTuple = updateProjectAgentPermissions(
    JSON.stringify({ plugin: [[entry, { keep: true }]] }),
    "sheep",
    { bash: { "echo e2e-seven-*": "allow" } },
  );
  assert.deepEqual(parse(withTuple).plugin, [[entry, { keep: true }]]);
});
