import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { ARTIFACT_TYPES, createStateService, MAX_STEERING_BYTES, STEERING_SCHEMA_VERSION } from "../src/state.js";

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
  return path.join(repo.commonDir, "flocky");
}

function legacyStateRoot(repo) {
  return path.join(repo.commonDir, "herdr");
}

function legacyArtifact(repo, type, planId, markdown) {
  const metadata = {
    schema: 1,
    artifactType: type,
    planId,
    identity: repo.commonDir,
    toplevel: repo.toplevel,
    createdAt: FIXED_TIME.toISOString(),
    updatedAt: FIXED_TIME.toISOString(),
  };
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n${markdown}`;
}

function seedLegacy(repo, directory, planId, text) {
  const target = path.join(legacyStateRoot(repo), directory, `${planId}.md`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  return target;
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
          // Only the artifact write rename fails; reconciliation performs no
          // renames on this path and is not the behavior under test.
          if (String(args[1]).endsWith(".md")) {
            renameCalls += 1;
            throw Object.assign(new Error("simulated rename failure"), { code: "EPERM" });
          }
          return Reflect.get(targetFs, key)(...args);
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

test("migrates legacy-only artifacts into the canonical flocky root and preserves them in place", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const planId = "developer-steering-flocky-state-20260901-01";
  const planBytes = legacyArtifact(repo, "plan", planId, "# Steering state\n\nPreserved across the migration.\n");
  const executionBytes = legacyArtifact(repo, "execution", planId, "# Legacy execution log\n");
  seedLegacy(repo, "plans", planId, planBytes);
  seedLegacy(repo, "executions", planId, executionBytes);
  assert.equal(fs.existsSync(stateRoot(repo)), false, "no canonical root exists before the first operation");

  const read = await state.readPlan(planId);
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Steering state\n\nPreserved across the migration.\n");
  assert.equal(
    fs.readFileSync(path.join(stateRoot(repo), "plans", `${planId}.md`), "utf8"),
    planBytes,
    "the canonical copy carries the exact legacy bytes",
  );
  assert.equal(
    fs.readFileSync(path.join(stateRoot(repo), "executions", `${planId}.md`), "utf8"),
    executionBytes,
  );
  assert.equal(fs.existsSync(path.join(legacyStateRoot(repo), "plans", `${planId}.md`)), true, "the legacy artifact is never auto-deleted");
  assert.equal(fs.existsSync(path.join(legacyStateRoot(repo), "executions", `${planId}.md`)), true);

  const executionRead = await state.readExecution(planId);
  assert.equal(executionRead.ok, true);
  assert.equal(executionRead.artifact.markdown, "# Legacy execution log\n");
});

test("accepts identical legacy and canonical bytes without modification", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const twinBytes = legacyArtifact(repo, "plan", "twin-plan", "# Twin plan\n");
  seedLegacy(repo, "plans", "twin-plan", twinBytes);
  fs.mkdirSync(path.join(stateRoot(repo), "plans"), { recursive: true });
  const canonicalTarget = path.join(stateRoot(repo), "plans", "twin-plan.md");
  fs.writeFileSync(canonicalTarget, twinBytes, "utf8");

  const read = await state.readPlan("twin-plan");
  assert.equal(read.ok, true);
  assert.equal(fs.readFileSync(canonicalTarget, "utf8"), twinBytes, "identical bytes are accepted untouched");
});

test("migrates disjoint legacy and canonical plan IDs without dropping either", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const written = await state.writePlan({ planId: "canonical-plan", markdown: "# Canonical side\n" });
  assert.equal(written.ok, true);
  const legacyBytes = legacyArtifact(repo, "plan", "legacy-plan", "# Legacy side\n");
  seedLegacy(repo, "plans", "legacy-plan", legacyBytes);

  const read = await state.readPlan("legacy-plan");
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Legacy side\n");
  assert.equal(
    fs.readFileSync(path.join(stateRoot(repo), "plans", "legacy-plan.md"), "utf8"),
    legacyBytes,
  );
  assert.equal(fs.existsSync(path.join(stateRoot(repo), "plans", "canonical-plan.md")), true, "the pre-existing canonical artifact survives");
  assert.equal(fs.existsSync(path.join(legacyStateRoot(repo), "plans", "legacy-plan.md")), true, "the legacy artifact is preserved in place");
});

test("fails closed on divergent legacy and canonical bytes without selecting or replacing either", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const legacyBytes = legacyArtifact(repo, "plan", "split-plan", "# Legacy version\n");
  const canonicalBytes = legacyArtifact(repo, "plan", "split-plan", "# Canonical version\n");
  seedLegacy(repo, "plans", "split-plan", legacyBytes);
  fs.mkdirSync(path.join(stateRoot(repo), "plans"), { recursive: true });
  const canonicalTarget = path.join(stateRoot(repo), "plans", "split-plan.md");
  fs.writeFileSync(canonicalTarget, canonicalBytes, "utf8");

  const read = await state.readPlan("split-plan");
  assert.equal(read.ok, false);
  assert.equal(read.error.code, "MIGRATION_CONFLICT");
  assert.equal(read.error.retryable, false);
  assert.deepEqual(
    read.error.conflicts.map((conflict) => [conflict.planId, conflict.reason]),
    [["split-plan", "DIVERGENT_BYTES"]],
  );
  assert.equal(fs.readFileSync(canonicalTarget, "utf8"), canonicalBytes, "the canonical artifact was not replaced");
  assert.equal(fs.readFileSync(path.join(legacyStateRoot(repo), "plans", "split-plan.md"), "utf8"), legacyBytes, "the legacy artifact was not replaced");
});

test("fails closed on an invalid legacy artifact instead of silently skipping it", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  seedLegacy(repo, "plans", "broken-plan", "no frontmatter here\n");

  const read = await state.readPlan("broken-plan");
  assert.equal(read.ok, false);
  assert.equal(read.error.code, "MIGRATION_CONFLICT");
  assert.equal(read.error.conflicts[0].reason, "CORRUPT_LEGACY_ARTIFACT");
  assert.equal(fs.existsSync(path.join(legacyStateRoot(repo), "plans", "broken-plan.md")), true);
  assert.equal(fs.existsSync(path.join(stateRoot(repo), "plans", "broken-plan.md")), false);
});

test("a later call completes an interrupted promotion idempotently and sweeps the stale staging temp", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const planId = "rescued-plan";
  const planBytes = legacyArtifact(repo, "plan", planId, "# Rescued plan\n");
  seedLegacy(repo, "plans", planId, planBytes);
  const canonicalDirectory = path.join(stateRoot(repo), "plans");
  fs.mkdirSync(canonicalDirectory, { recursive: true });
  // An orphan staging temp from a crashed promotion: inert, never promoted
  // from, and swept once stale.
  const orphan = path.join(canonicalDirectory, `${planId}.md.999.abcdef.migrating`);
  fs.writeFileSync(orphan, "# Orphan bytes from a crashed call\n", "utf8");
  fs.utimesSync(orphan, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

  const read = await state.readPlan(planId);
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Rescued plan\n");
  assert.equal(
    fs.readFileSync(path.join(canonicalDirectory, `${planId}.md`), "utf8"),
    planBytes,
    "the canonical copy carries the freshly validated legacy bytes, not the orphan",
  );
  assert.equal(fs.existsSync(orphan), false, "the stale orphan temp was swept");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-journal")), false, "no shared journal is created");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-lock")), false, "no migration lock is created");
  assert.equal(fs.readFileSync(path.join(legacyStateRoot(repo), "plans", `${planId}.md`), "utf8"), planBytes, "the legacy source is preserved");
});

test("a live staging temp from another contender is never swept or promoted from", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const planId = "live-temp-plan";
  const planBytes = legacyArtifact(repo, "plan", planId, "# Live plan\n");
  seedLegacy(repo, "plans", planId, planBytes);
  const canonicalDirectory = path.join(stateRoot(repo), "plans");
  fs.mkdirSync(canonicalDirectory, { recursive: true });
  // A fresh temp belongs to a concurrently running contender: it must be
  // left untouched while this call promotes from its own validated bytes.
  const live = path.join(canonicalDirectory, `${planId}.md.111.abcdef.migrating`);
  fs.writeFileSync(live, "# Another contender's staging bytes\n", "utf8");

  const read = await state.readPlan(planId);
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Live plan\n");
  assert.equal(
    fs.readFileSync(path.join(canonicalDirectory, `${planId}.md`), "utf8"),
    planBytes,
    "the canonical copy carries the validated legacy bytes",
  );
  assert.equal(fs.readFileSync(live, "utf8"), "# Another contender's staging bytes\n", "the live temp was neither swept nor promoted from");
});

test("retired migration lock and journal files are removed best-effort and never block reconciliation", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const planId = "retired-coordination-plan";
  const planBytes = legacyArtifact(repo, "plan", planId, "# Retired coordination\n");
  seedLegacy(repo, "plans", planId, planBytes);
  fs.mkdirSync(stateRoot(repo), { recursive: true });
  const lockPath = path.join(stateRoot(repo), ".migration-lock");
  const journalPath = path.join(stateRoot(repo), ".migration-journal");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, token: "retired", acquiredAt: "2020-01-01T00:00:00.000Z" }), "utf8");
  fs.writeFileSync(journalPath, "[]", "utf8");

  const read = await state.readPlan(planId);
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Retired coordination\n");
  assert.equal(fs.existsSync(lockPath), false, "the retired lock file was removed");
  assert.equal(fs.existsSync(journalPath), false, "the retired journal file was removed");
  assert.equal(
    fs.readFileSync(path.join(stateRoot(repo), "plans", `${planId}.md`), "utf8"),
    planBytes,
  );
});

test("leaves empty, oversized, and metadata-invalid legacy artifacts unpromoted", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const baseMetadata = (planId) => ({
    schema: 1,
    artifactType: "plan",
    planId,
    identity: repo.commonDir,
    toplevel: repo.toplevel,
    createdAt: FIXED_TIME.toISOString(),
    updatedAt: FIXED_TIME.toISOString(),
  });
  seedLegacy(repo, "plans", "empty-legacy", `---\n${JSON.stringify(baseMetadata("empty-legacy"), null, 2)}\n---\n`);
  seedLegacy(repo, "plans", "oversized-legacy", legacyArtifact(repo, "plan", "oversized-legacy", "x".repeat(1024 * 1024 + 1)));
  const missingToplevel = baseMetadata("metadata-legacy");
  delete missingToplevel.toplevel;
  seedLegacy(repo, "plans", "metadata-legacy", `---\n${JSON.stringify(missingToplevel, null, 2)}\n---\n# Body\n`);

  const read = await state.readPlan("empty-legacy");
  assert.equal(read.ok, false);
  assert.equal(read.error.code, "MIGRATION_CONFLICT");
  assert.equal(read.error.retryable, false);
  const reasons = new Map(read.error.conflicts.map((conflict) => [conflict.planId, conflict.reason]));
  assert.equal(reasons.get("empty-legacy"), "LEGACY_INVALID_MARKDOWN", "an empty legacy body is rejected");
  assert.equal(reasons.get("oversized-legacy"), "LEGACY_INVALID_MARKDOWN", "a legacy body above the 1 MiB cap is rejected");
  assert.equal(reasons.get("metadata-legacy"), "LEGACY_INVALID_METADATA", "missing required metadata is rejected");

  for (const planId of ["empty-legacy", "oversized-legacy", "metadata-legacy"]) {
    assert.equal(fs.existsSync(path.join(stateRoot(repo), "plans", `${planId}.md`)), false, `${planId} was never promoted`);
    assert.equal(fs.existsSync(path.join(legacyStateRoot(repo), "plans", `${planId}.md`)), true, `${planId} is preserved in the legacy root`);
  }
});

test("two contenders racing promotion elect exactly one winner; the loser fails closed", async () => {
  const repo = repository();
  const planId = "race-two-plan";
  const legacyBytesX = legacyArtifact(repo, "plan", planId, "# Version X\n");
  seedLegacy(repo, "plans", planId, legacyBytesX);
  const canonicalTarget = path.join(stateRoot(repo), "plans", `${planId}.md`);
  const legacyTarget = path.join(legacyStateRoot(repo), "plans", `${planId}.md`);
  // Rival contender B validated different legacy bytes and wins the atomic
  // exclusive create first; the legacy root advances with the winner.
  const legacyBytesY = legacyArtifact(repo, "plan", planId, "# Version Y\n");
  let raced = false;
  const racingFs = new Proxy(fs, {
    get(target, key) {
      if (key === "writeFileSync") {
        return (...args) => {
          if (!raced && args[0] === canonicalTarget && args[2]?.flag === "wx") {
            raced = true;
            fs.writeFileSync(canonicalTarget, legacyBytesY);
            fs.writeFileSync(legacyTarget, legacyBytesY);
          }
          return Reflect.get(target, key)(...args);
        };
      }
      return Reflect.get(target, key);
    },
  });

  const loser = await service({ cwd: repo.cwd, fs: racingFs }).readPlan(planId);
  assert.equal(raced, true, "both contenders reached the exclusive install");
  assert.equal(loser.ok, false, "the loser performs no divergent promotion");
  assert.equal(loser.error.code, "MIGRATION_CONFLICT");
  assert.equal(loser.error.retryable, false);
  assert.deepEqual(
    loser.error.conflicts.map((conflict) => [conflict.planId, conflict.reason]),
    [[planId, "DIVERGENT_BYTES"]],
  );
  assert.equal(fs.readFileSync(canonicalTarget, "utf8"), legacyBytesY, "the canonical copy is exactly the winner's whole bytes");
  assert.equal(fs.readFileSync(legacyTarget, "utf8"), legacyBytesY, "the legacy source is preserved");
  assert.deepEqual(fs.readdirSync(path.join(stateRoot(repo), "plans")), [`${planId}.md`], "no staging temps remain");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-journal")), false, "no shared journal is created");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-lock")), false, "no migration lock is created");

  const settled = await service({ cwd: repo.cwd }).readPlan(planId);
  assert.equal(settled.ok, true, "a later call settles idempotently on the winner's bytes");
  assert.equal(settled.artifact.markdown, "# Version Y\n");
});

test("three contenders racing promotion leave exactly one whole artifact and two fail-closed conflicts", async () => {
  const repo = repository();
  const planId = "race-three-plan";
  const legacyBytesX = legacyArtifact(repo, "plan", planId, "# Version X\n");
  seedLegacy(repo, "plans", planId, legacyBytesX);
  const canonicalDirectory = path.join(stateRoot(repo), "plans");
  const canonicalTarget = path.join(canonicalDirectory, `${planId}.md`);
  const legacyTarget = path.join(legacyStateRoot(repo), "plans", `${planId}.md`);
  // A third contender validated different legacy bytes and wins the atomic
  // exclusive create before either service contender installs.
  const legacyBytesZ = legacyArtifact(repo, "plan", planId, "# Version Z\n");
  let winnerInstalled = false;
  const racingFsA = new Proxy(fs, {
    get(target, key) {
      if (key === "writeFileSync") {
        return (...args) => {
          if (!winnerInstalled && args[0] === canonicalTarget && args[2]?.flag === "wx") {
            winnerInstalled = true;
            fs.writeFileSync(canonicalTarget, legacyBytesZ);
          }
          return Reflect.get(target, key)(...args);
        };
      }
      return Reflect.get(target, key);
    },
  });
  // A second loser observes the canonical target as absent (its read raced
  // the winner's install), then loses the exclusive create as well.
  let absentObserved = false;
  const racingFsB = new Proxy(fs, {
    get(target, key) {
      if (key === "readFileSync") {
        return (...args) => {
          if (args[0] === canonicalTarget && !absentObserved) {
            absentObserved = true;
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          return Reflect.get(target, key)(...args);
        };
      }
      return Reflect.get(target, key);
    },
  });

  const loserA = await service({ cwd: repo.cwd, fs: racingFsA }).readPlan(planId);
  assert.equal(winnerInstalled, true, "the winner installed before the first loser");
  assert.equal(loserA.ok, false);
  assert.equal(loserA.error.code, "MIGRATION_CONFLICT");
  assert.equal(loserA.error.retryable, false);

  const loserB = await service({ cwd: repo.cwd, fs: racingFsB }).readPlan(planId);
  assert.equal(absentObserved, true, "the second loser raced from an absent observation");
  assert.equal(loserB.ok, false);
  assert.equal(loserB.error.code, "MIGRATION_CONFLICT");
  assert.equal(loserB.error.retryable, false);
  assert.deepEqual(
    loserB.error.conflicts.map((conflict) => [conflict.planId, conflict.reason]),
    [[planId, "DIVERGENT_BYTES"]],
  );

  assert.equal(fs.readFileSync(canonicalTarget, "utf8"), legacyBytesZ, "the canonical copy is exactly the winner's whole bytes");
  assert.equal(fs.readFileSync(legacyTarget, "utf8"), legacyBytesX, "the legacy source is preserved");
  assert.deepEqual(fs.readdirSync(canonicalDirectory), [`${planId}.md`], "no staging temps remain");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-journal")), false, "no shared journal is created");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-lock")), false, "no migration lock is created");
});

test("repairs a corrupt canonical artifact from validated legacy bytes", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const planId = "repaired-plan";
  const planBytes = legacyArtifact(repo, "plan", planId, "# Repaired plan\n");
  seedLegacy(repo, "plans", planId, planBytes);
  const canonicalDirectory = path.join(stateRoot(repo), "plans");
  fs.mkdirSync(canonicalDirectory, { recursive: true });
  const canonicalTarget = path.join(canonicalDirectory, `${planId}.md`);
  fs.writeFileSync(canonicalTarget, "no frontmatter here\n", "utf8");

  const read = await state.readPlan(planId);
  assert.equal(read.ok, true);
  assert.equal(read.artifact.markdown, "# Repaired plan\n");
  assert.equal(fs.readFileSync(canonicalTarget, "utf8"), planBytes, "the corrupt copy was repaired with the validated legacy bytes");
  assert.deepEqual(fs.readdirSync(canonicalDirectory), [`${planId}.md`], "no guard or staging temps remain");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-journal")), false, "no shared journal is created");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-lock")), false, "no migration lock is created");
});

test("two contenders racing corrupt repair elect exactly one winner; the loser fails closed", async () => {
  const repo = repository();
  const planId = "race-repair-plan";
  const legacyBytesX = legacyArtifact(repo, "plan", planId, "# Repaired version X\n");
  seedLegacy(repo, "plans", planId, legacyBytesX);
  const canonicalDirectory = path.join(stateRoot(repo), "plans");
  fs.mkdirSync(canonicalDirectory, { recursive: true });
  const canonicalTarget = path.join(canonicalDirectory, `${planId}.md`);
  const legacyTarget = path.join(legacyStateRoot(repo), "plans", `${planId}.md`);
  fs.writeFileSync(canonicalTarget, "no frontmatter here\n", "utf8");

  // Contender A repairs the corrupt target first.
  const winner = await service({ cwd: repo.cwd }).readPlan(planId);
  assert.equal(winner.ok, true, "exactly one contender repairs the corrupt target");
  assert.equal(fs.readFileSync(canonicalTarget, "utf8"), legacyBytesX);

  // Contender B validated different legacy bytes and observes the target as
  // still corrupt (its read raced the winner's repair), then loses inside
  // the repair branch: the guard re-read finds the winner's valid bytes, so
  // B byte-compares and fails closed instead of unlinking the winner.
  const legacyBytesY = legacyArtifact(repo, "plan", planId, "# Repaired version Y\n");
  fs.writeFileSync(legacyTarget, legacyBytesY, "utf8");
  let staleObserved = false;
  const racingFs = new Proxy(fs, {
    get(target, key) {
      if (key === "readFileSync") {
        return (...args) => {
          if (args[0] === canonicalTarget && !staleObserved) {
            staleObserved = true;
            return Buffer.from("no frontmatter here\n");
          }
          return Reflect.get(target, key)(...args);
        };
      }
      return Reflect.get(target, key);
    },
  });

  const loser = await service({ cwd: repo.cwd, fs: racingFs }).readPlan(planId);
  assert.equal(staleObserved, true, "the loser raced from a corrupt observation");
  assert.equal(loser.ok, false, "the loser performs no divergent repair");
  assert.equal(loser.error.code, "MIGRATION_CONFLICT");
  assert.equal(loser.error.retryable, false);
  assert.deepEqual(
    loser.error.conflicts.map((conflict) => [conflict.planId, conflict.reason]),
    [[planId, "DIVERGENT_BYTES"]],
  );
  assert.equal(fs.readFileSync(canonicalTarget, "utf8"), legacyBytesX, "the canonical copy is exactly the winner's whole bytes");
  assert.equal(fs.readFileSync(legacyTarget, "utf8"), legacyBytesY, "the legacy source is preserved");
  assert.deepEqual(fs.readdirSync(canonicalDirectory), [`${planId}.md`], "no guard or staging temps remain");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-journal")), false, "no shared journal is created");
  assert.equal(fs.existsSync(path.join(stateRoot(repo), ".migration-lock")), false, "no migration lock is created");
});

test("reconciles an active legacy write as a conflict instead of last-writer-wins", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const first = legacyArtifact(repo, "plan", "live-plan", "# Legacy version one\n");
  seedLegacy(repo, "plans", "live-plan", first);

  const seeded = await state.readPlan("live-plan");
  assert.equal(seeded.ok, true, "the first legacy write migrates");
  assert.equal(seeded.artifact.markdown, "# Legacy version one\n");

  // An old-version writer overwrites the legacy copy after the migration.
  const second = legacyArtifact(repo, "plan", "live-plan", "# Legacy version two\n");
  seedLegacy(repo, "plans", "live-plan", second);

  const after = await state.readPlan("live-plan");
  assert.equal(after.ok, false);
  assert.equal(after.error.code, "MIGRATION_CONFLICT");
  assert.equal(after.error.retryable, false);
  assert.deepEqual(
    after.error.conflicts.map((conflict) => [conflict.planId, conflict.reason]),
    [["live-plan", "DIVERGENT_BYTES"]],
  );
  assert.equal(
    fs.readFileSync(path.join(stateRoot(repo), "plans", "live-plan.md"), "utf8"),
    first,
    "the canonical copy was not silently kept over the newer legacy write",
  );
  assert.equal(
    fs.readFileSync(path.join(legacyStateRoot(repo), "plans", "live-plan.md"), "utf8"),
    second,
    "the active legacy write was not silently lost",
  );
});

function steeringRoot(repo) {
  return path.join(repo.commonDir, "flocky", "steering");
}

function steeringEntries(repo, planId) {
  return path.join(steeringRoot(repo), planId, "entries");
}

test("steering publishes an immutable entry with service-assigned sequence, opaque id, timestamp, provenance, identity, and schema", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const submitted = await state.submitSteering({ planId: "steer-plan-01", content: "Hold the line on scope." });
  assert.equal(submitted.ok, true);
  const entry = submitted.entry;
  assert.equal(entry.schema, STEERING_SCHEMA_VERSION);
  assert.equal(entry.sequence, 1);
  assert.match(entry.id, /^st_[0-9a-f]{16}$/);
  assert.equal(entry.planId, "steer-plan-01");
  assert.equal(entry.identity, repo.commonDir);
  assert.equal(entry.content, "Hold the line on scope.");
  assert.equal(typeof entry.createdAt, "string");
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  assert.deepEqual(entry.provenance, {
    submitter: "developer",
    integration: "integration-asserted Developer context; not an authenticated human",
  });
  const fileName = `${String(1).padStart(10, "0")}-${entry.id}.json`;
  const stored = JSON.parse(fs.readFileSync(path.join(steeringEntries(repo, "steer-plan-01"), fileName), "utf8"));
  assert.deepEqual(stored, entry);
  assert.equal(fs.existsSync(path.join(steeringRoot(repo), "steer-plan-01", "queue.lock")), false);
  assert.equal(fs.existsSync(path.join(steeringRoot(repo), "steer-plan-01", "queue.journal")), false);
});

test("steering appends multiple ordered records immutably", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const first = await state.submitSteering({ planId: "ordered-plan", content: "First directive." });
  const second = await state.submitSteering({ planId: "ordered-plan", content: "Second directive." });
  const third = await state.submitSteering({ planId: "ordered-plan", content: "Third directive." });
  assert.equal(first.entry.sequence, 1);
  assert.equal(second.entry.sequence, 2);
  assert.equal(third.entry.sequence, 3);
  assert.notEqual(first.entry.id, second.entry.id);
  assert.notEqual(second.entry.id, third.entry.id);
  const names = fs.readdirSync(steeringEntries(repo, "ordered-plan")).sort();
  assert.equal(names.length, 3);
  const read = await state.readSteering("ordered-plan");
  assert.equal(read.ok, true);
  assert.deepEqual(read.entries.map((entry) => entry.sequence), [1, 2, 3]);
  assert.deepEqual(read.entries.map((entry) => entry.content), ["First directive.", "Second directive.", "Third directive."]);
  // Immutable: earlier files are untouched by later submits.
  assert.ok(read.entries[0].id === first.entry.id && read.entries[0].content === "First directive.");
});

test("steering handles concurrent submissions with scoped lock and exclusive create", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const results = await Promise.all(
    ["Alpha.", "Beta.", "Gamma.", "Delta.", "Epsilon."].map((content) => state.submitSteering({ planId: "concurrent-plan", content })),
  );
  for (const result of results) assert.equal(result.ok, true);
  const sequences = results.map((result) => result.entry.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [1, 2, 3, 4, 5]);
  const ids = new Set(results.map((result) => result.entry.id));
  assert.equal(ids.size, 5);
  const names = fs.readdirSync(steeringEntries(repo, "concurrent-plan")).sort();
  assert.equal(names.length, 5);
  const read = await state.readSteering("concurrent-plan");
  assert.equal(read.entries.length, 5);
  assert.deepEqual(read.entries.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
});

test("steering rejects unbounded content and non-planId schemas without filesystem writes", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  for (const content of ["", null, 42, "x".repeat(MAX_STEERING_BYTES + 1)]) {
    const failure = await state.submitSteering({ planId: "bounded-plan", content });
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "INVALID_STEERING_CONTENT");
  }
  const extra = await state.submitSteering({ planId: "bounded-plan", content: "ok", extra: "nope" });
  assert.equal(extra.ok, false);
  assert.equal(extra.error.code, "INVALID_REQUEST");
  const missing = await state.submitSteering({ planId: "bounded-plan" });
  assert.equal(missing.ok, false);
  for (const planId of ["../escape", "", ".hidden", null, 42]) {
    const failure = await state.submitSteering({ planId, content: "ok" });
    assert.equal(failure.ok, false);
  }
  assert.equal(fs.existsSync(steeringRoot(repo)), false);
});

test("steering resolves explicit planId or infers only one active target else AMBIGUOUS_TARGET with no repository-wide steering", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const none = await state.submitSteering({ content: "No target given." });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, "AMBIGUOUS_TARGET");
  assert.equal(fs.existsSync(steeringRoot(repo)), false);

  const first = await state.submitSteering({ planId: "infer-a", content: "Seed A." });
  assert.equal(first.ok, true);
  const inferred = await state.submitSteering({ content: "Inferred to the only target." });
  assert.equal(inferred.ok, true);
  assert.equal(inferred.entry.planId, "infer-a");
  assert.equal(inferred.entry.sequence, 2);

  const secondTarget = await state.submitSteering({ planId: "infer-b", content: "Seed B." });
  assert.equal(secondTarget.ok, true);
  const ambiguous = await state.submitSteering({ content: "Two targets, must fail." });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, "AMBIGUOUS_TARGET");
  assert.equal(ambiguous.error.retryable, false);
  // No repository-wide entry was created.
  assert.equal(fs.existsSync(path.join(steeringEntries(repo, "infer-a"), `${String(3).padStart(10, "0")}-x.json`)), false);
  const checkA = await state.checkSteering("infer-a");
  const checkB = await state.checkSteering("infer-b");
  assert.equal(checkA.total, 2);
  assert.equal(checkB.total, 1);
});

test("steering check shows unread without loading bodies and read returns ordered exact unread with no mutation", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  await state.submitSteering({ planId: "unread-plan", content: "One." });
  await state.submitSteering({ planId: "unread-plan", content: "Two." });
  await state.submitSteering({ planId: "unread-plan", content: "Three." });

  const check = await state.checkSteering("unread-plan");
  assert.equal(check.ok, true);
  assert.equal(check.planId, "unread-plan");
  assert.equal(check.total, 3);
  assert.equal(check.unread, 3);
  assert.equal(check.nextSequence, 4);
  assert.equal(check.highestContiguous, 0);

  const firstRead = await state.readSteering("unread-plan");
  assert.equal(firstRead.ok, true);
  assert.deepEqual(firstRead.entries.map((entry) => entry.sequence), [1, 2, 3]);
  const secondRead = await state.readSteering("unread-plan");
  assert.deepEqual(secondRead.entries.map((entry) => entry.id), firstRead.entries.map((entry) => entry.id));

  // Read performed no mutation: checkpoint still shows zero consumed.
  const after = await state.checkSteering("unread-plan");
  assert.equal(after.unread, 3);
  assert.equal(after.highestContiguous, 0);
});

test("steering failure and restart between read and consume leaves unread", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  await state.submitSteering({ planId: "restart-plan", content: "Directive one." });
  await state.submitSteering({ planId: "restart-plan", content: "Directive two." });

  const read = await state.readSteering("restart-plan");
  assert.equal(read.entries.length, 2);
  // Simulated failure: the consumer crashes before consume; a fresh service
  // instance restarts and must still see both as unread.
  const restarted = service({ cwd: repo.cwd });
  const reread = await restarted.readSteering("restart-plan");
  assert.equal(reread.entries.length, 2);
  assert.deepEqual(reread.entries.map((entry) => entry.id), read.entries.map((entry) => entry.id));
  const check = await restarted.checkSteering("restart-plan");
  assert.equal(check.unread, 2);
});

test("steering consume is idempotent and checkpoint holds highest contiguous plus consumed ids", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const one = await state.submitSteering({ planId: "consume-plan", content: "One." });
  const two = await state.submitSteering({ planId: "consume-plan", content: "Two." });
  const three = await state.submitSteering({ planId: "consume-plan", content: "Three." });

  // Non-contiguous consume: 1 and 3 leave highest at 1.
  const partial = await state.consumeSteering({ planId: "consume-plan", ids: [one.entry.id, three.entry.id] });
  assert.equal(partial.ok, true);
  assert.equal(partial.checkpoint.highestContiguous, 1);
  assert.deepEqual([...partial.checkpoint.consumedIds].sort(), [one.entry.id, three.entry.id].sort());
  const readAfterPartial = await state.readSteering("consume-plan");
  assert.deepEqual(readAfterPartial.entries.map((entry) => entry.sequence), [2]);

  // Completing the gap advances contiguously to 3.
  const completed = await state.consumeSteering({ planId: "consume-plan", ids: [two.entry.id] });
  assert.equal(completed.checkpoint.highestContiguous, 3);
  assert.equal(completed.unread, 0);
  const idempotent = await state.consumeSteering({ planId: "consume-plan", ids: [one.entry.id, two.entry.id, three.entry.id] });
  assert.equal(idempotent.ok, true);
  assert.equal(idempotent.checkpoint.highestContiguous, 3);
  assert.deepEqual(idempotent.checkpoint.consumedIds, completed.checkpoint.consumedIds);
  const empty = await state.readSteering("consume-plan");
  assert.equal(empty.entries.length, 0);

  const unknown = await state.consumeSteering({ planId: "consume-plan", ids: ["st_ffffffffffffffff"] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "STEERING_NOT_FOUND");
});

test("steering isolates unrelated Plan IDs with per-target scoped ordering", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const a1 = await state.submitSteering({ planId: "plan-A", content: "A one." });
  const b1 = await state.submitSteering({ planId: "plan-B", content: "B one." });
  const a2 = await state.submitSteering({ planId: "plan-A", content: "A two." });
  assert.equal(a1.entry.sequence, 1);
  assert.equal(b1.entry.sequence, 1);
  assert.equal(a2.entry.sequence, 2);

  const consumedA = await state.consumeSteering({ planId: "plan-A", ids: [a1.entry.id, a2.entry.id] });
  assert.equal(consumedA.checkpoint.highestContiguous, 2);
  const checkB = await state.checkSteering("plan-B");
  assert.equal(checkB.unread, 1);
  assert.equal(checkB.highestContiguous, 0);
  const readB = await state.readSteering("plan-B");
  assert.equal(readB.entries.length, 1);
  assert.equal(readB.entries[0].content, "B one.");
});

test("steering recovers a stale scoped lock and a torn journal without losing durable entries", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  await state.submitSteering({ planId: "recover-plan", content: "Durable one." });
  const targetDir = path.join(steeringRoot(repo), "recover-plan");
  const lockPath = path.join(targetDir, "queue.lock");
  fs.writeFileSync(lockPath, "stale-holder\n", "utf8");
  fs.utimesSync(lockPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  fs.writeFileSync(path.join(targetDir, "queue.journal"), "{ torn", "utf8");

  const second = await state.submitSteering({ planId: "recover-plan", content: "Durable two." });
  assert.equal(second.ok, true);
  assert.equal(second.entry.sequence, 2);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(path.join(targetDir, "queue.journal")), false);
  const read = await state.readSteering("recover-plan");
  assert.deepEqual(read.entries.map((entry) => entry.sequence), [1, 2]);
});
