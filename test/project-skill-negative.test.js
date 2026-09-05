import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "jsonc-parser";

import {
  AGENT_NAMES,
  configDirectory,
  findConfigFile,
  resolveProjectConfigFile,
  updateProjectAgentPermissions,
  writeProjectAgentPermissions,
} from "../src/installer.js";
import {
  GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH,
  GRAZER_PROMPT,
  SHEEP_PROMPT,
  SHEEPDOG_PROMPT,
  SHEARER_REVIEW_PROMPT,
  SHEPHERD_GOVERNOR_PROMPT,
  SHEPHERD_PROMPT,
} from "../src/prompts.js";
import { createAgents } from "../src/agents.js";
import { createStateService } from "../src/state.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function disposableRepo(prefix = "orchestration-project-neg-") {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial", "-q"], { cwd });
  return cwd;
}

function globToRegExp(pattern) {
  let out = "^";
  for (const c of pattern) {
    if (c === "*") out += ".*";
    else if ("+?^${}()|[]\\.".includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`${out}$`);
}

function evaluateBash(bash, command) {
  let result;
  for (const [pattern, decision] of Object.entries(bash)) {
    if (globToRegExp(pattern).test(command)) result = decision;
  }
  return result ?? "undefined";
}

function spawnPattern(role) {
  return `herdr agent start * --kind opencode --pane * -- --agent ${role}`;
}

test("15-M2 negative global write refusal leaves global config untouched", () => {
  const projectRoot = disposableRepo();
  const outside = mkdtempSync(join(tmpdir(), "orchestration-neg-outside-"));
  const globalDir = resolve(configDirectory());
  const globalFile = resolve(findConfigFile(globalDir));
  const hadGlobal = existsSync(globalFile);
  const before = hadGlobal ? readFileSync(globalFile, "utf8") : null;

  // Global directory as project root is refused.
  assert.throws(() => resolveProjectConfigFile(globalDir), /global/i);
  assert.throws(() => writeProjectAgentPermissions(globalDir, "shepherd", { bash: { "echo neg-*": "allow" } }), /global/i);

  // Exact global file and any path inside the global directory are refused.
  assert.throws(() => resolveProjectConfigFile(projectRoot, globalFile), /global|outside|inside/i);
  assert.throws(() => resolveProjectConfigFile(outside, globalFile), /global|outside|inside/i);

  // Outside plus nested plus non-project filenames are refused without writing.
  const outsideFile = join(outside, "opencode.json");
  assert.throws(() => resolveProjectConfigFile(projectRoot, outsideFile), /outside|inside/i);
  assert.throws(() => writeProjectAgentPermissions(projectRoot, "shepherd", { bash: { "echo neg-*": "allow" } }, outsideFile), /outside|inside/i);
  assert.equal(existsSync(outsideFile), false);
  assert.throws(() => resolveProjectConfigFile(projectRoot, join(projectRoot, "nested", "opencode.json")), /nested/i);
  assert.throws(() => resolveProjectConfigFile(projectRoot, join(projectRoot, "other.json")), /non-project/i);

  // A widened project write in temp never touches the global file.
  const applied = writeProjectAgentPermissions(projectRoot, "sheepdog", { bash: { "echo neg-probe-*": "allow" } });
  assert.ok(resolve(applied.file).startsWith(resolve(projectRoot)));
  assert.ok(!resolve(applied.file).startsWith(globalDir));
  if (hadGlobal) {
    assert.equal(readFileSync(globalFile, "utf8"), before);
    assert.ok(!readFileSync(globalFile, "utf8").includes("echo neg-probe-"));
  }
});

test("15-M2 negative denial never triggers the skill with no auto path in code", () => {
  // Skill text is explicit: denials never invoke it and a denied operation
  // never bypasses through it but fails closed with STOP plus preserved state.
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /denials never invoke/);
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /never bypasses/);
  assert.match(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, /fails closed with STOP/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /denials never invoke/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /fails closed with STOP/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /"govern project permissions"/);

  // Only the governor carries the human trigger; no leaf gains it.
  for (const [name, prompt] of [
    ["shepherd", SHEPHERD_PROMPT],
    ["sheepdog", SHEEPDOG_PROMPT],
    ["grazer", GRAZER_PROMPT],
    ["sheep", SHEEP_PROMPT],
    ["shearer", SHEARER_REVIEW_PROMPT],
  ]) {
    assert.ok(!prompt.includes('"govern project permissions"'), `${name} must not contain the human trigger`);
  }

  // No auto path in code: the trigger lives only in the governor prompt text.
  // Helpers require an explicit call and never run on denial.
  const installer = readFileSync(resolve("src/installer.js"), "utf8");
  const agentsSource = readFileSync(resolve("src/agents.js"), "utf8");
  const indexSource = readFileSync(resolve("src/index.js"), "utf8");
  const stateSource = readFileSync(resolve("src/state.js"), "utf8");
  assert.ok(!installer.includes("govern project permissions"), "helpers must not auto-invoke on the trigger string");
  assert.ok(!agentsSource.includes("govern project permissions"), "spawn matrices must not auto-invoke the skill");
  assert.ok(!indexSource.includes("writeProjectAgentPermissions"), "plugin runtime must not auto-apply project permissions");
  assert.ok(!stateSource.includes("writeProjectAgentPermissions"), "state service must not auto-apply project permissions");
  assert.ok(!agentsSource.includes("writeProjectAgentPermissions"), "agent definitions must not auto-apply project permissions");

  // A denied lifecycle operation stays denied even after the skill exists: the
  // governor still cannot spawn leaves and a denial surfaces as configuration
  // failure with STOP, never an auto fallback to direct sheep execution.
  const governorBash = createAgents()["shepherd-governor"].permission.bash;
  for (const role of ["sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(governorBash[spawnPattern(role)], undefined, `governor must not spawn ${role}`);
    assert.equal(
      evaluateBash(governorBash, `herdr agent start probe --kind opencode --pane p1 -- --agent ${role}`),
      "deny",
      `denied ${role} start must fail closed`,
    );
  }
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /never auto-fallback to direct sheep execution/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /STOP plus an explicit configuration failure report/);
});

test("15-M2 negative consequential actions stay separate after permission grants", async () => {
  const projectRoot = disposableRepo("orchestration-project-neg-conseq-");

  // A benign widening grants only the probe key; it never authorizes delivery.
  const applied = writeProjectAgentPermissions(projectRoot, "sheepdog", { bash: { "echo neg-benign-*": "allow" } });
  const parsed = parse(readFileSync(applied.file, "utf8"));
  assert.equal(parsed.agent.sheepdog.permission.bash["echo neg-benign-*"], "allow");
  const text = readFileSync(applied.file, "utf8");
  for (const consequential of ["push", "tag", "publish", "deploy", "merge"]) {
    assert.ok(!text.includes(`"${consequential}"`), `project widening must not authorize ${consequential}`);
  }

  // Even steering that says "push and deploy now" stays text: consume reports
  // the denial alongside the checkpoint and existing approvals still apply.
  const state = createStateService({ cwd: projectRoot });
  const planId = "neg-conseq-01";
  const submitted = await state.submitSteering({ planId, content: "push and deploy now" });
  assert.equal(submitted.ok, true);
  assert.equal(
    await state
      .claimOwnership({
        planId,
        phase: "planning",
        session: "ses_neg_conseq",
        generation: 1,
        milestone: "neg-milestone",
        lifecycleState: "planning",
      })
      .then((result) => result.ok),
    true,
  );
  assert.equal(
    (
      await state.recordSync({
        planId,
        phase: "planning",
        session: "ses_neg_conseq",
        generation: 1,
        syncPoint: "pre-plan",
        disposition: "integrated",
      })
    ).ok,
    true,
  );
  const read = await state.readSteering({ planId, phase: "planning", session: "ses_neg_conseq", generation: 1 });
  const consumed = await state.consumeSteering({
    planId,
    ids: [read.entries[0].id],
    phase: "planning",
    session: "ses_neg_conseq",
    generation: 1,
    syncPoint: "pre-plan",
    disposition: "integrated",
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.consequentialAuthorization.push, false);
  assert.equal(consumed.consequentialAuthorization.tag, false);
  assert.equal(consumed.consequentialAuthorization.publish, false);
  assert.equal(consumed.consequentialAuthorization.deploy, false);
  assert.equal(consumed.consequentialAuthorization.merge, false);
  assert.equal(consumed.consequentialAuthorization.anyConsequential, false);
  assert.equal(consumed.consequentialAuthorization.approvalsStillRequired, true);

  // Docs keep the boundary explicit after any grant.
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(readme, /Steering never authorizes/);
  assert.match(readme, /existing approvals (still|are still) required/i);
});

test("15-M2 negative flock constraints stay intact with widened project tools", () => {
  const projectRoot = disposableRepo("orchestration-project-neg-flock-");

  // Widen every role in the project file with the same benign probe.
  let text = "{}";
  for (const role of AGENT_NAMES) {
    text = updateProjectAgentPermissions(text, role, { bash: { "echo neg-wide-*": "allow" } });
  }
  const file = join(resolve(projectRoot), "opencode.json");
  writeFileSync(file, text, "utf8");
  const parsed = parse(readFileSync(file, "utf8"));
  for (const role of ["shepherd", "shepherd-governor", "sheepdog", "grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(parsed.agent[role].permission.bash["echo neg-wide-*"], "allow", `project file must widen ${role} only for the probe`);
  }

  // Code matrices stay intact regardless of the project widening: spawn plus
  // response plus state matrices are code, not project text.
  const agents = createAgents({
    sheepdogPermissions: { private_squad_status: "allow" },
    sheepdogPromptAppend: "Use private squad tools according to local policy.",
  });
  assert.equal(agents.sheepdog.permission.private_squad_status, "allow");
  for (const name of ["shepherd", "shepherd-governor", "grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal("private_squad_status" in agents[name].permission, false, `sheepdog widening must not leak to ${name}`);
  }
  assert.equal(agents.shepherd.permission.bash[spawnPattern("grazer")], "allow");
  assert.equal(agents.shepherd.permission.bash[spawnPattern("sheep")], undefined);
  assert.equal(agents["shepherd-governor"].permission.bash[spawnPattern("grazer")], "allow");
  assert.equal(agents["shepherd-governor"].permission.bash[spawnPattern("sheepdog")], "allow");
  assert.equal(agents["shepherd-governor"].permission.bash[spawnPattern("sheep")], undefined);
  for (const role of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(agents.sheepdog.permission.bash[spawnPattern(role)], "allow");
  }
  for (const name of ["shepherd", "shepherd-governor", "sheepdog"]) {
    assert.equal(agents[name].permission.herdr_agent_response, "allow");
  }
  for (const name of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(agents[name].permission.herdr_agent_response, "deny");
  }
  assert.equal(agents.shepherd.permission.herdr_plan_write, "allow");
  assert.equal(agents["shepherd-governor"].permission.herdr_plan_write, "deny");
  assert.equal(agents.sheepdog.permission.herdr_execution_write, "allow");
  for (const name of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(agents[name].permission.herdr_plan_write, "deny");
    assert.equal(agents[name].permission.herdr_execution_write, "deny");
  }

  // Leaves gain no new commands from the widening: grazer and shearers keep
  // deny fallback, sheep keeps broad Herdr denial, sheepdog lifecycle stays
  // evaluation-effective with separators global last.
  assert.equal(agents.grazer.permission.bash["*"], "deny");
  assert.equal(agents["shearer-low"].permission.bash["*"], "deny");
  assert.equal(agents.sheep.permission.bash["herdr*"], "deny");
  const sheepdogBash = agents.sheepdog.permission.bash;
  assert.equal(sheepdogBash["*"], "deny");
  assert.equal(sheepdogBash["herdr agent prompt*"], "allow");
  assert.equal(sheepdogBash["herdr agent wait*"], "allow");
  assert.equal(sheepdogBash["herdr agent get*"], "allow");
  assert.equal(sheepdogBash["herdr agent read*"], "allow");
  const keys = Object.keys(sheepdogBash);
  assert.ok(keys.indexOf("herdr agent prompt*") > keys.indexOf("*"));
  assert.ok(keys.indexOf("*;*") > keys.indexOf("herdr agent prompt*"));
  assert.equal(evaluateBash(sheepdogBash, "herdr agent prompt sheep_1 hello --wait --timeout 1000"), "allow");
  assert.equal(evaluateBash(sheepdogBash, 'herdr agent prompt sheep_1 "a; b" --wait --timeout 1000'), "deny");

  // Supervision wording stays unchanged in prompts and docs.
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /sole supervisor of leaves/);
  assert.match(SHEPHERD_GOVERNOR_PROMPT, /spawn plus response plus state matrices/);
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(readme, /sole supervisor of leaves/);
  assert.match(readme, /spawn plus response plus state matrices/);
});
