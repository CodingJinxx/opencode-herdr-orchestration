import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parse } from "jsonc-parser";

import {
  AGENT_MANIFEST_FILE,
  AGENT_MANIFEST_SCHEMA,
  AGENT_NAMES,
  KNOWN_OBSOLETE_AGENTS,
  PROJECT_CONFIG_FILE,
  PROJECT_CONFIG_FILENAMES,
  backupFile,
  configDirectory,
  findConfigFile,
  findProjectConfigFile,
  isOrchestrationPlugin,
  orchestrationOptions,
  packageEntry,
  packageVersion,
  readAgentFilesManifest,
  reconcileAgentFiles,
  removeAgentFilesManifest,
  resolveProjectConfigFile,
  restoreBackup,
  unownedObsoleteAgentFiles,
  updateAgentModels,
  updatePluginConfig,
  updateProjectAgentPermissions,
  validateOpenCode,
  writeAgentFilesManifest,
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

const cli = resolve("bin/orchestration.js");

function environment(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  };
}

function run(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: environment(home),
    windowsHide: true,
  });
}

function git(home, ...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: environment(home),
    windowsHide: true,
  }).trim();
}

function opencodeShim(listedAgents = AGENT_NAMES) {
  const lines = [
    "@echo off",
    'if "%~1"=="debug" if "%~2"=="agent" (',
    '  echo {"name":"%~3"}',
    "  exit /b 0",
    ")",
    'if "%~1"=="agent" if "%~2"=="list" (',
    ...listedAgents.map((name) => `  echo ${name} ^(primary^)`),
    "  exit /b 0",
    ")",
    "exit /b 1",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function brokenDebugShim() {
  return [
    "@echo off",
    'if "%~1"=="debug" if "%~2"=="agent" (',
    '  echo {"name":"someone-else"}',
    "  exit /b 0",
    ")",
    'if "%~1"=="agent" if "%~2"=="list" (',
    ...AGENT_NAMES.map((name) => `  echo ${name} ^(primary^)`),
    "  exit /b 0",
    ")",
    "exit /b 1",
  ].join("\r\n") + "\r\n";
}

function failingShim() {
  return "@echo off\r\nexit /b 1\r\n";
}

function npmShim() {
  return "@echo off\r\nexit /b 0\r\n";
}

function withShimPath(bin, body) {
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  try {
    body();
  } finally {
    process.env.PATH = previousPath;
  }
}

function configRootOf(home) {
  return join(home, ".config", "opencode");
}

function digestOf(content) {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function writeManifest(configRoot, files, version = "0.1.5") {
  writeFileSync(
    join(configRoot, AGENT_MANIFEST_FILE),
    `${JSON.stringify(
      { schema: AGENT_MANIFEST_SCHEMA, package: "opencode-herdr-orchestration", version, digestAlgorithm: "sha256", files },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function readManifest(configRoot) {
  return JSON.parse(readFileSync(join(configRoot, AGENT_MANIFEST_FILE), "utf8"));
}

function seedObsoleteFile(configRoot, name, content = `# ${name}\n`) {
  mkdirSync(join(configRoot, "agent"), { recursive: true });
  writeFileSync(join(configRoot, "agent", `${name}.md`), content, "utf8");
  return content;
}

function runCli(home, bin, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...environment(home), PATH: `${bin}${delimiter}${process.env.PATH}` },
    windowsHide: true,
  });
}

test("installs, reports, and cleanly uninstalls the global hook", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-installer-"));
  const installed = run(home, "install-hooks");
  assert.equal(installed.status, 0, installed.stderr);
  const hooksPath = git(home, "config", "--global", "--get", "core.hooksPath");
  assert.equal(existsSync(join(hooksPath, "pre-push")), true);

  const status = run(home, "status");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).hooks.active, true);

  const removed = run(home, "uninstall-hooks");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(hooksPath), false);
  assert.equal(run(home, "status").stdout.includes('"active": false'), true);
});

test("preserves JSONC comments, unrelated plugins, and tuple options", () => {
  const source = `{
  // Keep this comment.
  "plugin": [
    "other-plugin", // Keep this plugin comment.
    ["opencode-herdr-orchestration@0.1.0", { "private": true }],
  ],
}
`;
  const entry = "file:///home/user/.config/opencode/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const updated = updatePluginConfig(source, entry);
  assert.match(updated, /Keep this comment/);
  assert.match(updated, /Keep this plugin comment/);
  const parsed = parse(updated, [], { allowTrailingComma: true });
  assert.equal(parsed.plugin[0], "other-plugin");
  assert.deepEqual(parsed.plugin[1], [entry, { private: true }]);
});

test("adds, removes, and deduplicates only orchestration registrations", () => {
  const entry = "file:///tmp/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const added = updatePluginConfig("{\n  \"plugin\": [\"other\"]\n}\n", entry);
  assert.deepEqual(parse(added).plugin, ["other", entry]);

  const duplicate = JSON.stringify({ plugin: ["other", "opencode-herdr-orchestration", [entry, { keep: true }]] });
  const deduplicated = updatePluginConfig(duplicate, entry);
  assert.deepEqual(parse(deduplicated).plugin, ["other", entry]);
  assert.deepEqual(parse(updatePluginConfig(deduplicated, entry, true)).plugin, ["other"]);
});

test("configures agent models while preserving plugin options and comments", () => {
  const source = `{
  // Keep this comment.
  "plugin": [["opencode-herdr-orchestration", {
    "private": true, // Keep this option comment.
    "workerModel": "old/worker",
  }]],
}
`;
  const entry = "file:///tmp/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const updated = updateAgentModels(source, entry, {
    shepherdModel: "provider/shepherd",
    sheepdogModel: "provider/sheepdog",
    sheepdogVariant: "medium",
    grazerVariant: "low",
    workerModel: "provider/worker",
    workerVariant: "high",
    reviewerModel: "provider/reviewer",
  });
  assert.match(updated, /Keep this comment/);
  assert.match(updated, /Keep this option comment/);
  assert.deepEqual(orchestrationOptions(updated), {
    private: true,
    workerModel: "provider/worker",
    workerVariant: "high",
    grazerVariant: "low",
    sheepdogModel: "provider/sheepdog",
    sheepdogVariant: "medium",
    shepherdModel: "provider/shepherd",
    reviewerModel: "provider/reviewer",
  });
});

test("empty model choices restore package defaults", () => {
  const entry = "file:///tmp/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const source = JSON.stringify({
    plugin: [[entry, {
      workerModel: "custom/worker",
      workerVariant: "high",
      grazerVariant: "medium",
      sheepdogModel: "custom/sheepdog",
      sheepdogVariant: "low",
      reviewerModel: "custom/reviewer",
      keep: true,
    }]],
  });
  const updated = updateAgentModels(source, entry, {
    workerModel: "",
    workerVariant: "",
    grazerVariant: "",
    sheepdogModel: "",
    sheepdogVariant: "",
    reviewerModel: "",
  });
  assert.deepEqual(orchestrationOptions(updated), { keep: true });
});

test("promotes a first-time plugin registration to model options", () => {
  const entry = "file:///tmp/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const updated = updateAgentModels("{}", entry, {
    shepherdModel: "provider/shepherd",
    workerModel: "provider/worker",
    grazerVariant: "high",
    workerVariant: "low",
    reviewerModel: "provider/reviewer",
  });
  assert.deepEqual(parse(updated).plugin, [[entry, {
    shepherdModel: "provider/shepherd",
    workerModel: "provider/worker",
    grazerVariant: "high",
    workerVariant: "low",
    reviewerModel: "provider/reviewer",
  }]]);
});

test("creates portable file URLs and recognizes package registrations", () => {
  const entry = packageEntry(process.platform === "win32" ? "C:\\Users\\Test\\.config\\opencode" : "/home/test/.config/opencode");
  assert.match(entry, /^file:\/\//);
  assert.equal(isOrchestrationPlugin(entry), true);
  assert.equal(isOrchestrationPlugin(["opencode-herdr-orchestration@1.2.3", {}]), true);
  assert.equal(isOrchestrationPlugin("unrelated"), false);
});

test("restores a config backup after failed validation", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-rollback-"));
  const file = join(home, "opencode.jsonc");
  writeFileSync(file, "original", "utf8");
  const backup = backupFile(file, new Date("2026-01-01T00:00:00Z"));
  writeFileSync(file, "broken", "utf8");
  restoreBackup(file, backup);
  assert.equal(readFileSync(file, "utf8"), "original");
});

test("removes a first-time config after failed validation", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-rollback-"));
  const file = join(home, "opencode.jsonc");
  writeFileSync(file, "broken", "utf8");
  restoreBackup(file, null, false);
  assert.equal(existsSync(file), false);
});

test("runs through Windows command shims", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-shim-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(configRootOf(home), { recursive: true });
  writeFileSync(join(bin, "opencode.cmd"), opencodeShim(), "utf8");
  const result = spawnSync(process.execPath, [cli, "status"], {
    encoding: "utf8",
    env: { ...environment(home), PATH: `${bin}${delimiter}${process.env.PATH}` },
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.detectedAgents, AGENT_NAMES);
  assert.equal(parsed.agentsReady, true);
  assert.deepEqual(parsed.obsoleteAgentFiles, []);
});

test("refuses to replace an existing hooks path without force", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-installer-"));
  git(home, "config", "--global", "core.hooksPath", join(home, "existing-hooks"));
  const refused = run(home, "install-hooks");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already/);

  const forced = run(home, "install-hooks", "--force");
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(git(home, "config", "--global", "--get", "core.hooksPath"), /opencode-herdr-orchestration/);
});

test("registers the renamed agent roles without compatibility fallbacks", () => {
  assert.deepEqual(AGENT_NAMES, [
    "shepherd",
    "shepherd-governor",
    "sheepdog",
    "grazer",
    "sheep",
    "shearer-low",
    "shearer-medium",
    "developer",
  ]);
  for (const legacy of [
    "shepherd-plan",
    "shepherd-build",
    "sheep-plan",
    "sheep-build",
    "shearer-review-low",
    "shearer-review-medium",
  ]) {
    assert.equal(AGENT_NAMES.includes(legacy), false);
    assert.equal(KNOWN_OBSOLETE_AGENTS.includes(legacy), true);
  }
});

test("deletes only matching manifest-owned obsolete agent files", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "orchestration-manifest-"));
  const owned = seedObsoleteFile(configRoot, "shepherd-plan");
  seedObsoleteFile(configRoot, "sheep-build", "locally edited\n");
  seedObsoleteFile(configRoot, "sheperd-build");
  const outside = join(configRoot, "outside.md");
  writeFileSync(outside, "keep me\n", "utf8");
  writeManifest(configRoot, [
    { path: "agent/shepherd-plan.md", digest: digestOf(owned), version: "0.1.5" },
    { path: "agent/sheep-build.md", digest: digestOf("original\n"), version: "0.1.5" },
    { path: "../outside.md", digest: digestOf("keep me\n"), version: "0.1.5" },
  ]);

  const report = reconcileAgentFiles(configRoot, { remove: false });

  assert.deepEqual(report.deleted, ["agent/shepherd-plan.md"]);
  assert.equal(existsSync(join(configRoot, "agent", "shepherd-plan.md")), false);
  assert.equal(existsSync(join(configRoot, "agent", "sheep-build.md")), true);
  assert.equal(existsSync(join(configRoot, "agent", "sheperd-build.md")), true);
  assert.equal(readFileSync(outside, "utf8"), "keep me\n");

  const modified = report.remediation.filter((item) => item.reason === "modified");
  const unowned = report.remediation.filter((item) => item.reason === "unowned");
  const unsafe = report.remediation.filter((item) => item.reason === "unsafe");
  assert.deepEqual(modified.map((item) => item.path), ["agent/sheep-build.md"]);
  assert.match(modified[0].remediation, /review and delete it manually/i);
  assert.deepEqual(unowned.map((item) => item.path), ["agent/sheperd-build.md"]);
  assert.match(unowned[0].remediation, /archive or delete it manually/i);
  assert.equal(unsafe.length, 1);
  assert.match(unsafe[0].remediation, /Nothing was deleted/);
  assert.deepEqual(report.manifestEntries.map((entry) => entry.path), ["agent/sheep-build.md", "../outside.md"]);
});

test("remove mode deletes every manifest-proven file and prunes the managed root", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "orchestration-manifest-"));
  const first = seedObsoleteFile(configRoot, "sheep-plan");
  const second = seedObsoleteFile(configRoot, "shearer-review-low");
  writeManifest(configRoot, [
    { path: "agent/sheep-plan.md", digest: digestOf(first), version: "0.1.5" },
    { path: "agent/shearer-review-low.md", digest: digestOf(second), version: "0.1.5" },
  ]);

  const report = reconcileAgentFiles(configRoot, { remove: true });

  assert.deepEqual(report.deleted.sort(), ["agent/shearer-review-low.md", "agent/sheep-plan.md"]);
  assert.equal(existsSync(join(configRoot, "agent")), false);
  assert.deepEqual(report.manifestEntries, []);
});

test("an unreadable manifest blocks deletion and reports remediation", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "orchestration-manifest-"));
  const content = seedObsoleteFile(configRoot, "shepherd-plan");
  writeFileSync(join(configRoot, AGENT_MANIFEST_FILE), "{ not json", "utf8");

  const report = reconcileAgentFiles(configRoot, { remove: true });

  assert.deepEqual(report.deleted, []);
  const unreadable = report.remediation.filter((item) => item.reason === "unreadable");
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].remediation, /no package-owned files were touched/i);
  assert.equal(readFileSync(join(configRoot, "agent", "shepherd-plan.md"), "utf8"), content);
});

test("writes and removes the agent files manifest idempotently", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "orchestration-manifest-"));
  assert.deepEqual(readAgentFilesManifest(configRoot), { manifest: null, error: null });

  const entries = [{ path: "agent/sheep-build.md", digest: "abc", version: "0.1.5" }];
  const first = writeAgentFilesManifest(configRoot, entries, "0.2.0");
  assert.equal(first.changed, true);
  const parsed = readAgentFilesManifest(configRoot).manifest;
  assert.equal(parsed.schema, AGENT_MANIFEST_SCHEMA);
  assert.equal(parsed.version, "0.2.0");
  assert.deepEqual(parsed.files, entries);

  const second = writeAgentFilesManifest(configRoot, entries, "0.2.0");
  assert.equal(second.changed, false);
  assert.equal(unownedObsoleteAgentFiles(configRoot).length, 0);

  removeAgentFilesManifest(configRoot);
  assert.equal(existsSync(join(configRoot, AGENT_MANIFEST_FILE)), false);
});

test("validates every agent role through debug agent and agent list", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-validate-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode.cmd"), opencodeShim(), "utf8");
  withShimPath(bin, () => {
    assert.equal(validateOpenCode(home), true);
  });
});

test("validation fails when debug agent resolves a different role", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-validate-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode.cmd"), brokenDebugShim(), "utf8");
  withShimPath(bin, () => {
    assert.throws(() => validateOpenCode(home), new RegExp(`did not resolve ${AGENT_NAMES[0]}`));
  });
});

test("validation fails when the agent list misses a role", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-validate-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode.cmd"), opencodeShim(AGENT_NAMES.filter((name) => name !== "grazer")), "utf8");
  withShimPath(bin, () => {
    assert.throws(() => validateOpenCode(home), /agent list did not report: grazer/);
  });
});

test("install updates the manifest only after validation passes", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-install-"));
  const configRoot = configRootOf(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode.cmd"), opencodeShim(), "utf8");
  writeFileSync(join(bin, "npm.cmd"), npmShim(), "utf8");
  const owned = seedObsoleteFile(configRoot, "shepherd-plan");
  seedObsoleteFile(configRoot, "sheep-plan");
  writeManifest(configRoot, [{ path: "agent/shepherd-plan.md", digest: digestOf(owned), version: "0.1.5" }]);

  const result = runCli(home, bin, "install");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Removed obsolete package-owned agent file: agent\/shepherd-plan\.md/);
  assert.match(result.stdout, /Action required \(unowned\): .+agent\\sheep-plan\.md/);
  assert.equal(existsSync(join(configRoot, "agent", "shepherd-plan.md")), false);
  assert.equal(existsSync(join(configRoot, "agent", "sheep-plan.md")), true);
  const manifest = readManifest(configRoot);
  assert.equal(manifest.version, packageVersion(resolve(".")));
  assert.deepEqual(manifest.files, []);
  const config = readFileSync(join(configRoot, "opencode.jsonc"), "utf8");
  assert.match(config, /opencode-herdr-orchestration/);
});

test("install keeps the manifest untouched when validation fails", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-install-"));
  const configRoot = configRootOf(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode.cmd"), failingShim(), "utf8");
  writeFileSync(join(bin, "npm.cmd"), npmShim(), "utf8");
  const owned = seedObsoleteFile(configRoot, "shepherd-plan");
  writeManifest(configRoot, [{ path: "agent/shepherd-plan.md", digest: digestOf(owned), version: "0.1.5" }]);
  const manifestBefore = readFileSync(join(configRoot, AGENT_MANIFEST_FILE), "utf8");

  const result = runCli(home, bin, "install");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /validation failed/);
  assert.equal(existsSync(join(configRoot, "agent", "shepherd-plan.md")), true);
  assert.equal(readFileSync(join(configRoot, "agent", "shepherd-plan.md"), "utf8"), owned);
  assert.equal(readFileSync(join(configRoot, AGENT_MANIFEST_FILE), "utf8"), manifestBefore);
  assert.equal(existsSync(join(configRoot, "opencode.jsonc")), false);
});

test("uninstall removes manifest-proven files, the manifest, and reports unowned leftovers", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "orchestration-uninstall-"));
  const configRoot = configRootOf(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(bin, "npm.cmd"), npmShim(), "utf8");
  writeFileSync(join(configRoot, "opencode.jsonc"), JSON.stringify({ plugin: ["file:///tmp/plugin.js"] }), "utf8");
  const owned = seedObsoleteFile(configRoot, "sheep-build");
  seedObsoleteFile(configRoot, "sheperd-plan");
  writeManifest(configRoot, [{ path: "agent/sheep-build.md", digest: digestOf(owned), version: "0.1.5" }]);

  const result = runCli(home, bin, "uninstall");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Removed package-owned agent file: agent\/sheep-build\.md/);
  assert.match(result.stdout, /Action required \(unowned\): .+agent\\sheperd-plan\.md/);
  assert.equal(existsSync(join(configRoot, "agent", "sheep-build.md")), false);
  assert.equal(existsSync(join(configRoot, "agent", "sheperd-plan.md")), true);
  assert.equal(existsSync(join(configRoot, AGENT_MANIFEST_FILE)), false);
});

// 15-M1 project config helpers plus Governor skill section.

test("15-M1 project helpers confine fail-closed to the project root and refuse global plus outside", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "orchestration-project-"));
  const outside = mkdtempSync(join(tmpdir(), "orchestration-outside-"));
  const globalDir = configDirectory();
  const globalFile = findConfigFile(globalDir);

  assert.equal(PROJECT_CONFIG_FILE, "opencode.json");
  assert.deepEqual([...PROJECT_CONFIG_FILENAMES], ["opencode.jsonc", "opencode.json"]);

  // Defaults to opencode.json per docs when nothing exists.
  assert.equal(findProjectConfigFile(projectRoot), join(resolve(projectRoot), "opencode.json"));

  // Prefers existing opencode.jsonc for JSONC coherence.
  writeFileSync(join(projectRoot, "opencode.jsonc"), "{}\n", "utf8");
  assert.equal(findProjectConfigFile(projectRoot), join(resolve(projectRoot), "opencode.jsonc"));

  // Refuses global directory as project root and writes nothing.
  assert.throws(() => resolveProjectConfigFile(globalDir), /global/i);
  assert.throws(() => writeProjectAgentPermissions(globalDir, "shepherd", { bash: { "echo probe-*": "allow" } }), /global/i);

  // Refuses the exact global file and any path inside the global directory.
  assert.throws(() => resolveProjectConfigFile(projectRoot, globalFile), /global|outside|inside/i);
  assert.throws(() => resolveProjectConfigFile(outside, globalFile), /global|outside|inside/i);

  // Refuses outside plus nested plus non-project filenames without writing.
  const outsideFile = join(outside, "opencode.json");
  assert.throws(() => resolveProjectConfigFile(projectRoot, outsideFile), /outside|inside/i);
  assert.throws(() => writeProjectAgentPermissions(projectRoot, "shepherd", { bash: { "echo probe-*": "allow" } }, outsideFile), /outside|inside/i);
  assert.equal(existsSync(outsideFile), false);
  mkdirSync(join(projectRoot, "nested"), { recursive: true });
  assert.throws(() => resolveProjectConfigFile(projectRoot, join(projectRoot, "nested", "opencode.json")), /nested/i);
  assert.throws(() => resolveProjectConfigFile(projectRoot, join(projectRoot, "other.json")), /non-project/i);
  assert.throws(() => updateProjectAgentPermissions("{}", "not an agent!", { bash: "allow" }), /Invalid agent name/);
  assert.throws(() => updateProjectAgentPermissions("{}", "shepherd", { bash: "sometimes" }), /Invalid action/);
  assert.throws(() => updateProjectAgentPermissions("{ not json", "shepherd", { bash: "allow" }), /Invalid OpenCode JSONC/);
});

test("15-M1 project helpers preserve comments plus plugins plus tuples", () => {
  const source = `{
  // Keep this comment.
  "plugin": [
    "other-plugin", // Keep this plugin comment.
    ["opencode-herdr-orchestration@0.1.0", { "private": true }],
  ],
  "agent": {
    "shepherd": { "permission": { "bash": { "git status*": "allow" } } },
  },
}
`;
  const entry = "file:///home/user/.config/opencode/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const updated = updateProjectAgentPermissions(source, "shepherd-governor", { bash: { "echo project-probe-*": "allow" } });
  assert.match(updated, /Keep this comment/);
  assert.match(updated, /Keep this plugin comment/);
  const parsed = parse(updated, [], { allowTrailingComma: true });
  assert.equal(parsed.plugin[0], "other-plugin");
  assert.deepEqual(parsed.plugin[1], ["opencode-herdr-orchestration@0.1.0", { private: true }]);
  assert.deepEqual(parsed.agent.shepherd.permission.bash, { "git status*": "allow" });
  assert.deepEqual(parsed.agent["shepherd-governor"].permission.bash, { "echo project-probe-*": "allow" });
  // Unrelated entry helper still sees the tuple shape.
  assert.equal(isOrchestrationPlugin(parsed.plugin[1]), true);
  assert.equal(isOrchestrationPlugin(entry), true);
});

test("15-M1 project helpers keep tuple shape while setting and deleting per-key", () => {
  const entry = "file:///tmp/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const source = JSON.stringify({ plugin: [[entry, { keep: true }]], agent: { sheep: { permission: { bash: { "keep-*": "allow", "remove-*": "allow" } } } } });
  const set = updateProjectAgentPermissions(source, "sheep", { bash: { "added-*": "allow" } });
  const parsedSet = parse(set);
  assert.deepEqual(parsedSet.plugin, [[entry, { keep: true }]]);
  assert.equal(parsedSet.agent.sheep.permission.bash["keep-*"], "allow");
  assert.equal(parsedSet.agent.sheep.permission.bash["added-*"], "allow");

  const deleted = updateProjectAgentPermissions(set, "sheep", { bash: { "remove-*": undefined } });
  const parsedDeleted = parse(deleted);
  assert.deepEqual(parsedDeleted.plugin, [[entry, { keep: true }]]);
  assert.equal(parsedDeleted.agent.sheep.permission.bash["keep-*"], "allow");
  assert.equal(parsedDeleted.agent.sheep.permission.bash["remove-*"], undefined);
  assert.equal(parsedDeleted.agent.sheep.permission.bash["added-*"], "allow");

  // Shorthand set plus tool delete.
  const shorthand = updateProjectAgentPermissions("{}", "grazer", { skill: "ask" });
  assert.equal(parse(shorthand).agent.grazer.permission.skill, "ask");
  const toolDeleted = updateProjectAgentPermissions(shorthand, "grazer", { skill: undefined });
  assert.equal(parse(toolDeleted).agent?.grazer?.permission?.skill, undefined);
});

test("15-M1 project helpers target all seven roles and reapply idempotently", () => {
  let text = "{}";
  for (const role of AGENT_NAMES) {
    text = updateProjectAgentPermissions(text, role, { bash: { "echo idempotent-*": "allow" } });
  }
  const parsed = parse(text);
  for (const role of ["shepherd", "shepherd-governor", "sheepdog", "grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(parsed.agent[role].permission.bash["echo idempotent-*"], "allow", `${role} must gain the probe rule`);
  }
  const reapplied = updateProjectAgentPermissions(text, "sheep", { bash: { "echo idempotent-*": "allow" } });
  assert.equal(reapplied, text);

  const projectRoot = mkdtempSync(join(tmpdir(), "orchestration-project-idem-"));
  const first = writeProjectAgentPermissions(projectRoot, "sheepdog", { bash: { "echo idempotent-*": "allow" } });
  assert.equal(first.changed, true);
  assert.equal(first.existed, false);
  assert.equal(first.file, join(resolve(projectRoot), "opencode.json"));
  assert.match(readFileSync(first.file, "utf8"), /echo idempotent/);
  const second = writeProjectAgentPermissions(projectRoot, "sheepdog", { bash: { "echo idempotent-*": "allow" } });
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.equal(readFileSync(second.file, "utf8"), readFileSync(first.file, "utf8"));
  // Backup discipline: first write had no prior file so no backup; an update creates one.
  const third = writeProjectAgentPermissions(projectRoot, "sheepdog", { bash: { "echo idempotent-*": "deny" } });
  assert.equal(third.changed, true);
  assert.ok(third.backup && existsSync(third.backup));
});

test("15-M1 README documents reload via debug config with global-only fallback", () => {
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(readme, /Project permission skill \(15-M1\)/);
  assert.match(readme, /opencode\.json/);
  assert.match(readme, /opencode debug config/);
  assert.match(readme, /OPENCODE_DISABLE_PROJECT_CONFIG=1/);
  assert.match(readme, /restart OpenCode intentionally/);
  assert.match(readme, /"govern project permissions"/);
  assert.match(readme, /git diff/);
  assert.match(readme, /denials never invoke/i);
  assert.match(readme, /prompt-embedded/);
  assert.match(readme, /SKILL\.md/);
  assert.match(readme, /PROJECT_CONFIG_FILE/);
  assert.match(readme, /GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH/);
});

test("15-M1 Governor skill stays prompt-embedded with trigger plus preservation plus inspectability", () => {
  assert.equal(typeof GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH, "string");
  assert.ok(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH.length > 200);
  assert.ok(SHEPHERD_GOVERNOR_PROMPT.includes(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH));
  assert.ok(SHEPHERD_GOVERNOR_PROMPT.includes('"govern project permissions"'));
  for (const fragment of [
    "prompt-embedded",
    "SKILL.md",
    "denials never invoke",
    "fails closed with STOP",
    "opencode.json",
    "never touch global config",
    "per-key merge",
    "stay preserved",
    "Preserve unrelated work",
    "git diff",
    "opencode debug config",
    "OPENCODE_DISABLE_PROJECT_CONFIG=1",
    "restart OpenCode intentionally",
    "Supervision stays unchanged",
    "sole supervisor of leaves",
    "spawn plus response plus state matrices intact",
  ]) {
    assert.ok(SHEPHERD_GOVERNOR_PROMPT.includes(fragment), `governor must contain skill fragment: ${fragment}`);
  }
  for (const role of ["shepherd", "shepherd-governor", "sheepdog", "grazer", "sheep", "shearer-low", "shearer-medium"]) {
    assert.ok(SHEPHERD_GOVERNOR_PROMPT.includes(role), `governor skill must name ${role} as text`);
  }
  // Leaves gain no skill commands and stay unchanged.
  for (const [name, prompt] of [
    ["shepherd", SHEPHERD_PROMPT],
    ["sheepdog", SHEEPDOG_PROMPT],
    ["grazer", GRAZER_PROMPT],
    ["sheep", SHEEP_PROMPT],
    ["shearer", SHEARER_REVIEW_PROMPT],
  ]) {
    assert.ok(!prompt.includes(GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH), `${name} must not contain the governor skill paragraph`);
    assert.ok(!prompt.includes('"govern project permissions"'), `${name} must not contain the human trigger`);
  }
  // Supervision matrices stay intact with no new spawn targets.
  const agents = createAgents();
  function pattern(role) {
    return `herdr agent start * --kind opencode --pane * -- --agent ${role}`;
  }
  assert.equal(agents["shepherd-governor"].permission.bash[pattern("grazer")], "allow");
  assert.equal(agents["shepherd-governor"].permission.bash[pattern("sheepdog")], "allow");
  for (const role of ["sheep", "shearer-low", "shearer-medium"]) {
    assert.equal(agents["shepherd-governor"].permission.bash[pattern(role)], undefined, `governor must not spawn ${role}`);
  }
  const spawns = [...SHEPHERD_GOVERNOR_PROMPT.matchAll(/--agent (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(spawns, ["grazer", "sheepdog"]);
});
