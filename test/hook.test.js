import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const hook = resolve("hooks/pre-push");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function runHook(cwd, mode, input) {
  const shell = process.platform === "win32" ? windowsGitShell() : "/bin/sh";
  return spawnSync(shell, [hook, "origin", "unused"], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, SHEPHERD_MODE: mode },
    windowsHide: true,
  });
}

function windowsGitShell() {
  const gitExecutable = execFileSync("where.exe", ["git"], { encoding: "utf8" })
    .split(/\r?\n/)
    .find((line) => line.trim().toLowerCase().endsWith("git.exe"));
  if (!gitExecutable) throw new Error("Unable to locate Git for Windows.");
  return resolve(dirname(dirname(gitExecutable.trim())), "bin", "sh.exe");
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

test("allows ordinary users without an orchestration mode", () => {
  const { cwd, sha } = repository();
  const update = `refs/heads/feature ${sha} refs/heads/feature ${"0".repeat(40)}\n`;
  assert.equal(runHook(cwd, "none", update).status, 0);
});

test("denies shepherd and all flock pushes; final delivery belongs to the governor", () => {
  const { cwd, sha } = repository();
  const update = `refs/heads/feature ${sha} refs/heads/feature ${"0".repeat(40)}\n`;
  for (const mode of ["shepherd", "sheepdog", "grazer", "sheep", "shearer"]) {
    const result = runHook(cwd, mode, update);
    assert.equal(result.status, 1, `${mode} must not push`);
    assert.match(result.stderr, /final delivery belongs to the shepherd-governor/);
  }
});

test("allows governor to push only its current same-named non-protected branch", () => {
  const { cwd, sha } = repository("feature");
  const allowed = `refs/heads/feature ${sha} refs/heads/feature ${"0".repeat(40)}\n`;
  const wrongDestination = `refs/heads/feature ${sha} refs/heads/other ${"0".repeat(40)}\n`;
  const wrongSource = `refs/heads/other ${sha} refs/heads/feature ${"0".repeat(40)}\n`;
  const deletion = `refs/heads/feature ${"0".repeat(40)} refs/heads/feature ${"0".repeat(40)}\n`;
  assert.equal(runHook(cwd, "governor", allowed).status, 0);
  assert.equal(runHook(cwd, "governor", wrongDestination).status, 1);
  assert.equal(runHook(cwd, "governor", wrongSource).status, 1);
  assert.equal(runHook(cwd, "governor", deletion).status, 1);
});

test("denies protected and configured protected governor branches", () => {
  const main = repository("main");
  const mainUpdate = `refs/heads/main ${main.sha} refs/heads/main ${"0".repeat(40)}\n`;
  assert.equal(runHook(main.cwd, "governor", mainUpdate).status, 1);

  const release = repository("release");
  git(release.cwd, "config", "--add", "orchestration.protectedBranch", "release");
  const releaseUpdate = `refs/heads/release ${release.sha} refs/heads/release ${"0".repeat(40)}\n`;
  assert.equal(runHook(release.cwd, "governor", releaseUpdate).status, 1);
});
