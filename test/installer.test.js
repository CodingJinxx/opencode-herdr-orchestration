import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parse } from "jsonc-parser";

import {
  backupFile,
  isOrchestrationPlugin,
  orchestrationOptions,
  packageEntry,
  restoreBackup,
  updateAgentModels,
  updatePluginConfig,
} from "../src/installer.js";

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
    shepherdModel: "provider/shepherd",
    reviewerModel: "provider/reviewer",
  });
});

test("empty model choices restore package defaults", () => {
  const entry = "file:///tmp/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const source = JSON.stringify({
    plugin: [[entry, { workerModel: "custom/worker", workerVariant: "high", reviewerModel: "custom/reviewer", keep: true }]],
  });
  const updated = updateAgentModels(source, entry, { workerModel: "", workerVariant: "", reviewerModel: "" });
  assert.deepEqual(orchestrationOptions(updated), { keep: true });
});

test("promotes a first-time plugin registration to model options", () => {
  const entry = "file:///tmp/node_modules/opencode-herdr-orchestration/src/plugin.js";
  const updated = updateAgentModels("{}", entry, {
    shepherdModel: "provider/shepherd",
    workerModel: "provider/worker",
    workerVariant: "low",
    reviewerModel: "provider/reviewer",
  });
  assert.deepEqual(parse(updated).plugin, [[entry, {
    shepherdModel: "provider/shepherd",
    workerModel: "provider/worker",
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
  writeFileSync(
    join(bin, "opencode.cmd"),
    '@echo off\r\nif "%1"=="agent" (echo shepherd-build ^(primary^)& exit /b 0)\r\necho {"name":"shepherd-build"}\r\n',
    "utf8",
  );
  const result = spawnSync(process.execPath, [cli, "status"], {
    encoding: "utf8",
    env: { ...environment(home), PATH: `${bin}${delimiter}${process.env.PATH}` },
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
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
