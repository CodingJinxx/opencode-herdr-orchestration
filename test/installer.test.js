import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  assert.equal(JSON.parse(status.stdout).active, true);

  const removed = run(home, "uninstall-hooks");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(hooksPath), false);
  assert.equal(run(home, "status").stdout.includes('"active": false'), true);
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
