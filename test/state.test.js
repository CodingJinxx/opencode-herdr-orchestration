import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { ARTIFACT_TYPES, createStateService } from "../src/state.js";

const FIXED_TIME = new Date("2026-08-31T12:00:00.000Z");

function realpath(value) {
  return (fs.realpathSync.native ?? fs.realpathSync)(value);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function repository(prefix = "orchestration-state-") {
  const cwd = mkdtempSync(path.join(tmpdir(), prefix));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial", "-q"], { cwd });
  const commonDir = realpath(path.resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));
  const toplevel = realpath(path.resolve(cwd));
  return { cwd, toplevel, commonDir };
}

function linkWorktree(repo, branch = "linked-worktree") {
  const cwd = `${repo.cwd}-linked`;
  git(repo.cwd, "worktree", "add", "-b", branch, cwd);
  return { cwd, toplevel: realpath(path.resolve(cwd)) };
}

function service(options = {}) {
  return createStateService({ now: () => FIXED_TIME, ...options });
}

function stateRoot(repo) {
  return path.join(repo.commonDir, "herdr");
}

test("normalizes Windows short paths through the native realpath binding", async () => {
  const shortRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\state-repo";
  const longRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\state-repo";
  const realpathSync = (value) => value;
  realpathSync.native = () => longRoot;

  const state = service({
    cwd: shortRoot,
    path: path.win32,
    fs: { realpathSync },
    runGit: async (_cwd, args) => args[1] === "--git-common-dir"
      ? `${shortRoot}\\.git\n`
      : `${shortRoot}\n`,
  });

  const layout = await state.layout();
  assert.deepEqual(layout, { identity: longRoot, toplevel: longRoot });
});

test("round-trips a plan artifact with stamped metadata and stable creation time", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });

  const written = await state.writePlan({
    planId: "flock-state-01",
    markdown: "# Task contract\n\nImplement the state layer.\n",
    metadata: { owner: "shepherd-build" },
  });
  assert.equal(written.ok, true);
  assert.equal(written.artifact.metadata.artifactType, "plan");
  assert.equal(written.artifact.metadata.planId, "flock-state-01");
  assert.equal(written.artifact.metadata.schema, 1);
  assert.equal(written.artifact.metadata.identity, repo.commonDir);
  assert.equal(written.artifact.metadata.toplevel, repo.toplevel);
  assert.equal(written.artifact.metadata.createdAt, FIXED_TIME.toISOString());
  assert.equal(written.artifact.metadata.updatedAt, FIXED_TIME.toISOString());
  assert.equal(written.artifact.metadata.owner, "shepherd-build");
  assert.equal(
    written.artifact.path,
    path.join(stateRoot(repo), "plans", "flock-state-01.md"),
  );

  const read = await state.readPlan("flock-state-01");
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Task contract\n\nImplement the state layer.\n");
  assert.deepEqual(read.provenance, {
    recordedToplevel: repo.toplevel,
    currentToplevel: repo.toplevel,
    toplevelMatches: true,
  });

  const rewritten = await state.writePlan({
    planId: "flock-state-01",
    markdown: "# Task contract\n\nUpdated.\n",
    metadata: { owner: "shepherd-build" },
  });
  assert.equal(rewritten.ok, true);
  assert.equal(rewritten.artifact.metadata.createdAt, FIXED_TIME.toISOString());

  const reread = await state.readPlan("flock-state-01");
  assert.equal(reread.artifact.markdown, "# Task contract\n\nUpdated.\n");
  assert.equal(reread.artifact.metadata.owner, "shepherd-build");
});

test("stores execution artifacts below the executions directory only", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });

  const written = await state.writeExecution({
    planId: "flock-state-01",
    markdown: "# Execution log\n\nStep one complete.\n",
  });
  assert.equal(written.ok, true);
  assert.equal(
    written.artifact.path,
    path.join(stateRoot(repo), "executions", "flock-state-01.md"),
  );
  assert.equal(written.artifact.metadata.artifactType, "execution");

  const read = await state.readExecution("flock-state-01");
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Execution log\n\nStep one complete.\n");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), "plans", "flock-state-01.md")), false);

  // The plan and execution namespaces are separate directories: an execution
  // artifact is invisible to plan reads and vice versa.
  const noPlan = await state.readPlan("flock-state-01");
  assert.equal(noPlan.ok, false);
  assert.equal(noPlan.error.code, "NOT_FOUND");

  fs.mkdirSync(path.join(stateRoot(repo), "plans"), { recursive: true });
  fs.copyFileSync(written.artifact.path, path.join(stateRoot(repo), "plans", "flock-state-01.md"));
  const misplaced = await state.readPlan("flock-state-01");
  assert.equal(misplaced.ok, false);
  assert.equal(misplaced.error.code, "ARTIFACT_TYPE_MISMATCH");
  assert.equal(misplaced.error.retryable, false);
});

test("rejects invalid artifact types and plan IDs without touching the filesystem", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });

  for (const type of ["notes", "Plan", "", null, 42, undefined]) {
    const failure = await state.writeArtifact(type, { planId: "valid-id", markdown: "# x\n" });
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "INVALID_ARTIFACT_TYPE");
    assert.equal(failure.error.retryable, false);
  }

  for (const planId of ["", "../escape", "a/b", "a\\b", ".hidden", "sp ace", "x".repeat(65), null, 42]) {
    const failure = await state.writePlan({ planId, markdown: "# x\n" });
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "INVALID_PLAN_ID");
  }

  assert.equal(await state.readArtifact("plan", "../escape").then((r) => r.error.code), "INVALID_PLAN_ID");
  assert.equal(fs.existsSync(stateRoot(repo)), false);
});

test("rejects invalid markdown and metadata", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });

  for (const markdown of ["", null, 42, "x".repeat(1024 * 1024 + 1)]) {
    const failure = await state.writePlan({ planId: "valid-id", markdown });
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "INVALID_MARKDOWN");
  }

  const badValue = await state.writePlan({ planId: "valid-id", markdown: "# x\n", metadata: { owner: 7 } });
  assert.equal(badValue.error.code, "INVALID_METADATA");

  const badKey = await state.writePlan({ planId: "valid-id", markdown: "# x\n", metadata: { "bad key!": "v" } });
  assert.equal(badKey.error.code, "INVALID_METADATA");

  const reserved = await state.writePlan({ planId: "valid-id", markdown: "# x\n", metadata: { identity: "fake" } });
  assert.equal(reserved.error.code, "INVALID_METADATA");

  assert.equal(fs.existsSync(stateRoot(repo)), false);
});

test("shares one common directory across linked worktrees and accepts top-level mismatch", async () => {
  const repo = repository();
  const linked = linkWorktree(repo);
  assert.notEqual(linked.toplevel, repo.toplevel);

  const fromMain = service({ cwd: repo.cwd });
  const fromLinked = service({ cwd: linked.cwd });

  const mainLayout = await fromMain.layout();
  const linkedLayout = await fromLinked.layout();
  assert.equal(linkedLayout.identity, mainLayout.identity);
  assert.equal(linkedLayout.identity, repo.commonDir);
  assert.notEqual(linkedLayout.toplevel, mainLayout.toplevel);

  const written = await fromMain.writePlan({
    planId: "shared-plan",
    markdown: "# Shared plan\n\nVisible from every linked worktree.\n",
  });
  assert.equal(written.ok, true);

  const readFromLinked = await fromLinked.readPlan("shared-plan");
  assert.equal(readFromLinked.ok, true);
  assert.equal(readFromLinked.artifact.markdown, "# Shared plan\n\nVisible from every linked worktree.\n");
  assert.equal(readFromLinked.provenance.toplevelMatches, false);
  assert.equal(readFromLinked.provenance.recordedToplevel, repo.toplevel);
  assert.equal(readFromLinked.provenance.currentToplevel, linked.toplevel);

  const writtenFromLinked = await fromLinked.writeExecution({
    planId: "shared-plan",
    markdown: "# Shared execution\n\nWritten from the linked worktree.\n",
  });
  assert.equal(writtenFromLinked.ok, true);
  const readFromMain = await fromMain.readExecution("shared-plan");
  assert.equal(readFromMain.ok, true);
  assert.equal(readFromMain.provenance.toplevelMatches, false);
  assert.equal(readFromMain.provenance.recordedToplevel, linked.toplevel);
});

test("fails atomically and retains prior artifact bytes when rename fails", async () => {
  const repo = repository();
  const target = path.join(stateRoot(repo), "plans", "atomic-plan.md");
  const state = service({ cwd: repo.cwd });

  const first = await state.writePlan({ planId: "atomic-plan", markdown: "# Version one\n" });
  assert.equal(first.ok, true);
  const priorBytes = fs.readFileSync(target, "utf8");

  let renameCalls = 0;
  const failingFs = new Proxy(fs, {
    get(targetFs, key) {
      if (key === "renameSync") {
        return (...args) => {
          renameCalls += 1;
          throw Object.assign(new Error("simulated rename failure"), { code: "EPERM" });
        };
      }
      return Reflect.get(targetFs, key);
    },
  });

  const failing = service({ cwd: repo.cwd, fs: failingFs });
  const second = await failing.writePlan({ planId: "atomic-plan", markdown: "# Version two\n" });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "WRITE_FAILED");
  assert.equal(second.error.retryable, true);
  assert.equal(renameCalls, 1);

  assert.equal(fs.readFileSync(target, "utf8"), priorBytes);
  assert.equal(priorBytes.includes("# Version one"), true);
  assert.equal(
    fs.readdirSync(path.join(stateRoot(repo), "plans")).some((name) => name.endsWith(".tmp")),
    false,
  );

  const recovered = await state.writePlan({ planId: "atomic-plan", markdown: "# Version two\n" });
  assert.equal(recovered.ok, true);
  assert.equal(fs.readFileSync(target, "utf8").includes("# Version two"), true);
});

test("rejects artifacts written by a different repository identity", async () => {
  const repoA = repository("orchestration-state-a-");
  const repoB = repository("orchestration-state-b-");
  const stateA = service({ cwd: repoA.cwd });
  const stateB = service({ cwd: repoB.cwd });

  const written = await stateA.writePlan({ planId: "foreign-plan", markdown: "# From A\n" });
  assert.equal(written.ok, true);

  fs.mkdirSync(path.join(stateRoot(repoB), "plans"), { recursive: true });
  fs.copyFileSync(
    written.artifact.path,
    path.join(stateRoot(repoB), "plans", "foreign-plan.md"),
  );

  const read = await stateB.readPlan("foreign-plan");
  assert.equal(read.ok, false);
  assert.equal(read.error.code, "IDENTITY_MISMATCH");
  assert.equal(read.error.retryable, false);

  const overwrite = await stateB.writePlan({ planId: "foreign-plan", markdown: "# From B\n" });
  assert.equal(overwrite.ok, false);
  assert.equal(overwrite.error.code, "IDENTITY_MISMATCH");
});

test("reports schema, plan ID, and corruption mismatches as recoverable structured errors", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const plansDir = path.join(stateRoot(repo), "plans");

  const missing = await state.readPlan("no-such-plan");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "NOT_FOUND");
  assert.equal(missing.error.retryable, true);

  const written = await state.writePlan({ planId: "mismatch-plan", markdown: "# x\n" });
  assert.equal(written.ok, true);

  fs.writeFileSync(
    path.join(plansDir, "schema-plan.md"),
    `---\n${JSON.stringify({ ...written.artifact.metadata, schema: 99 })}\n---\n# x\n`,
    "utf8",
  );
  assert.equal((await state.readPlan("schema-plan")).error.code, "SCHEMA_MISMATCH");

  fs.writeFileSync(
    path.join(plansDir, "id-plan.md"),
    `---\n${JSON.stringify({ ...written.artifact.metadata, planId: "other-plan" })}\n---\n# x\n`,
    "utf8",
  );
  assert.equal((await state.readPlan("id-plan")).error.code, "PLAN_ID_MISMATCH");

  fs.writeFileSync(path.join(plansDir, "corrupt-plan.md"), "no frontmatter here\n", "utf8");
  const corrupt = await state.readPlan("corrupt-plan");
  assert.equal(corrupt.error.code, "CORRUPT_ARTIFACT");

  const repaired = await state.writePlan({ planId: "corrupt-plan", markdown: "# repaired\n" });
  assert.equal(repaired.ok, true);
  assert.equal((await state.readPlan("corrupt-plan")).artifact.markdown, "# repaired\n");
});

test("reports Git resolution failures as retryable and recovers once Git works", async () => {
  const repo = repository();
  let failing = true;
  const state = service({
    cwd: repo.cwd,
    runGit: async (cwd, args) => {
      if (failing) throw new Error("git is temporarily unavailable");
      return git(cwd, ...args);
    },
  });

  const failedWrite = await state.writePlan({ planId: "git-plan", markdown: "# x\n" });
  assert.equal(failedWrite.ok, false);
  assert.equal(failedWrite.error.code, "GIT_UNAVAILABLE");
  assert.equal(failedWrite.error.retryable, true);

  const failedRead = await state.readPlan("git-plan");
  assert.equal(failedRead.error.code, "GIT_UNAVAILABLE");
  assert.equal(failedRead.error.retryable, true);

  failing = false;
  const written = await state.writePlan({ planId: "git-plan", markdown: "# x\n" });
  assert.equal(written.ok, true);
  assert.equal((await state.readPlan("git-plan")).ok, true);
});

test("exposes artifact type constants used by generic write and read", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });

  assert.deepEqual(ARTIFACT_TYPES, { PLAN: "plan", EXECUTION: "execution" });

  const plan = await state.writeArtifact(ARTIFACT_TYPES.PLAN, { planId: "generic", markdown: "# p\n" });
  const execution = await state.writeArtifact(ARTIFACT_TYPES.EXECUTION, { planId: "generic", markdown: "# e\n" });
  assert.equal(plan.ok, true);
  assert.equal(execution.ok, true);
  assert.equal((await state.readArtifact(ARTIFACT_TYPES.PLAN, "generic")).artifact.metadata.artifactType, "plan");
  assert.equal((await state.readArtifact(ARTIFACT_TYPES.EXECUTION, "generic")).artifact.metadata.artifactType, "execution");
});
