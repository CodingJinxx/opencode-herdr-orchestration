import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hook = resolve("hooks/pre-push");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function runHook(cwd, mode, input) {
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\sh.exe" : "/bin/sh";
  return spawnSync(shell, [hook, "origin", "unused"], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, SHEPHERD_MODE: mode },
    windowsHide: true,
  });
}

function repository(branch = "feature") {
  const cwd = mkdtempSync(join(tmpdir(), "orchestration-hook-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial", "-q"], { cwd });
  git(cwd, "branch", "-M", branch);
  return { cwd, sha: git(cwd, "rev-parse", "HEAD") };
}

test("allows ordinary users and shepherd-build", () => {
  const { cwd, sha } = repository();
  const update = `refs/heads/feature ${sha} refs/heads/feature ${"0".repeat(40)}\n`;
  assert.equal(runHook(cwd, "none", update).status, 0);
  assert.equal(runHook(cwd, "build", update).status, 0);
});

test("denies all worker and reviewer pushes", () => {
  const { cwd, sha } = repository();
  const update = `refs/heads/feature ${sha} refs/heads/feature ${"0".repeat(40)}\n`;
  for (const mode of ["sheep-build", "sheep-plan", "review"]) {
    assert.equal(runHook(cwd, mode, update).status, 1);
  }
});

test("allows plan to push only its current same-named non-protected branch", () => {
  const { cwd, sha } = repository("feature");
  const allowed = `refs/heads/feature ${sha} refs/heads/feature ${"0".repeat(40)}\n`;
  const wrongDestination = `refs/heads/feature ${sha} refs/heads/other ${"0".repeat(40)}\n`;
  assert.equal(runHook(cwd, "plan", allowed).status, 0);
  assert.equal(runHook(cwd, "plan", wrongDestination).status, 1);
});

test("denies protected and configured protected planning branches", () => {
  const main = repository("main");
  const mainUpdate = `refs/heads/main ${main.sha} refs/heads/main ${"0".repeat(40)}\n`;
  assert.equal(runHook(main.cwd, "plan", mainUpdate).status, 1);

  const release = repository("release");
  git(release.cwd, "config", "--add", "orchestration.protectedBranch", "release");
  const releaseUpdate = `refs/heads/release ${release.sha} refs/heads/release ${"0".repeat(40)}\n`;
  assert.equal(runHook(release.cwd, "plan", releaseUpdate).status, 1);
});
