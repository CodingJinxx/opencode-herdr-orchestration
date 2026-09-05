import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { createStateService } from "../src/state.js";
import plugin from "../src/index.js";
import { STATE_TOOLS, STEERING_TOOLS, RAW_STEERING_TOOLS, OWNERSHIP_TOOLS } from "../src/agents.js";

const FIXED_TIME = new Date("2026-09-01T12:00:00.000Z");

function realpath(value) {
  return (fs.realpathSync.native ?? fs.realpathSync)(value);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function repository(prefix = "m4-regression-") {
  const cwd = mkdtempSync(path.join(tmpdir(), prefix));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial", "-q"], { cwd });
  const commonDir = realpath(path.resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));
  const toplevel = realpath(path.resolve(cwd));
  return { cwd, toplevel, commonDir };
}

function linkWorktree(repo, branch) {
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

function ownershipClaim(planId, overrides = {}) {
  return {
    planId,
    phase: "planning",
    session: "ses_m4_plan",
    generation: 1,
    milestone: "m4-milestone-01",
    lifecycleState: "planning",
    currentObjective: "Bounded M4 objective summary.",
    currentAction: "Bounded M4 action summary.",
    activeSheepdogTarget: "",
    relevantRevision: "rev-m4-01",
    pendingConsequentialAction: "",
    ...overrides,
  };
}

function pluginContext(agent) {
  return {
    agent,
    abort: new AbortController().signal,
    metadata() {},
  };
}

test("M4 linked worktree shares one common directory for M1 plan plus execution artifacts", async () => {
  const repo = repository();
  const linked = linkWorktree(repo, "m4-linked-m1");
  const fromMain = service({ cwd: repo.cwd });
  const fromLinked = service({ cwd: linked.cwd });

  const mainLayout = await fromMain.layout();
  const linkedLayout = await fromLinked.layout();
  assert.equal(linkedLayout.identity, mainLayout.identity);
  assert.equal(linkedLayout.identity, repo.commonDir);
  assert.notEqual(linkedLayout.toplevel, mainLayout.toplevel);

  const written = await fromMain.writePlan({
    planId: "m4-shared-plan",
    markdown: "# M4 shared plan\n\nVisible from every linked worktree.\n",
  });
  assert.equal(written.ok, true);
  assert.equal(
    written.artifact.path,
    path.join(stateRoot(repo), "plans", "m4-shared-plan.md"),
  );

  const readFromLinked = await fromLinked.readPlan("m4-shared-plan");
  assert.equal(readFromLinked.ok, true);
  assert.equal(readFromLinked.artifact.markdown, "# M4 shared plan\n\nVisible from every linked worktree.\n");
  assert.equal(readFromLinked.provenance.toplevelMatches, false);
  assert.equal(readFromLinked.provenance.recordedToplevel, repo.toplevel);
  assert.equal(readFromLinked.provenance.currentToplevel, linked.toplevel);

  const execFromLinked = await fromLinked.writeExecution({
    planId: "m4-shared-plan",
    markdown: "# M4 shared execution\n\nWritten from the linked worktree.\n",
  });
  assert.equal(execFromLinked.ok, true);
  const readExecFromMain = await fromMain.readExecution("m4-shared-plan");
  assert.equal(readExecFromMain.ok, true);
  assert.equal(readExecFromMain.artifact.markdown, "# M4 shared execution\n\nWritten from the linked worktree.\n");

  // A fresh service instance in the same linked worktree (new process simulation)
  // sees the same durable state with no shared memory.
  const restartedLinked = service({ cwd: linked.cwd });
  assert.equal((await restartedLinked.readPlan("m4-shared-plan")).ok, true);
  assert.equal((await restartedLinked.readExecution("m4-shared-plan")).ok, true);
});

test("M4 linked worktree shares steering plus ownership across service instances", async () => {
  const repo = repository();
  const linked = linkWorktree(repo, "m4-linked-steer");
  const main = service({ cwd: repo.cwd });
  const peer = service({ cwd: linked.cwd });

  const submitted = await peer.submitSteering({ planId: "m4-shared-steer", content: "Steer from the linked worktree." });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.entry.sequence, 1);

  // Another service instance on the main worktree sees the same queue without mutation.
  const restartedMain = service({ cwd: repo.cwd });
  const check = await restartedMain.checkSteering("m4-shared-steer");
  assert.equal(check.ok, true);
  assert.equal(check.total, 1);
  assert.equal(check.unread, 1);
  const read = await restartedMain.readSteering("m4-shared-steer");
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].content, "Steer from the linked worktree.");

  // Ownership claimed on main is visible from the linked peer, fenced by session plus generation.
  const claimed = await main.claimOwnership(ownershipClaim("m4-shared-steer"));
  assert.equal(claimed.ok, true);
  const ownerCheck = await main.checkSteering({
    planId: "m4-shared-steer",
    phase: "planning",
    session: "ses_m4_plan",
    generation: 1,
  });
  assert.equal(ownerCheck.ok, true);
  const nonOwner = await peer.checkSteering({
    planId: "m4-shared-steer",
    phase: "governance",
    session: "ses_m4_other",
    generation: 1,
  });
  assert.equal(nonOwner.ok, false);
  assert.equal(nonOwner.error.code, "NOT_AUTHORITATIVE_PHASE");
  // The same owner proof succeeds from the linked worktree because identity is the common directory.
  const peerOwner = await peer.checkSteering({
    planId: "m4-shared-steer",
    phase: "planning",
    session: "ses_m4_plan",
    generation: 1,
  });
  assert.equal(peerOwner.ok, true);
});

test("M4 migrates legacy artifacts across service instances and linked worktrees", async () => {
  const repo = repository();
  const planId = "m4-migrated-plan";
  const planBytes = legacyArtifact(repo, "plan", planId, "# M4 migrated plan\n");
  seedLegacy(repo, "plans", planId, planBytes);
  assert.equal(fs.existsSync(stateRoot(repo)), false);

  // First service instance migrates on read.
  const first = service({ cwd: repo.cwd });
  const migrated = await first.readPlan(planId);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.artifact.markdown, "# M4 migrated plan\n");
  assert.equal(
    fs.readFileSync(path.join(stateRoot(repo), "plans", `${planId}.md`), "utf8"),
    planBytes,
  );
  assert.equal(fs.existsSync(path.join(legacyStateRoot(repo), "plans", `${planId}.md`)), true);

  // A new service instance (simulated restarted process) settles idempotently on the winner.
  const second = service({ cwd: repo.cwd });
  const settled = await second.readPlan(planId);
  assert.equal(settled.ok, true);
  assert.equal(settled.artifact.markdown, "# M4 migrated plan\n");

  // A linked worktree peer sharing the common directory sees the same canonical bytes.
  const linked = linkWorktree(repo, "m4-linked-migrate");
  const peer = service({ cwd: linked.cwd });
  const fromLinked = await peer.readPlan(planId);
  assert.equal(fromLinked.ok, true);
  assert.equal(fromLinked.artifact.markdown, "# M4 migrated plan\n");
});

test("M4 end to end M1 through M3 submit plus ownership plus sync plus consume", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });
  const planId = "m4-e2e-01";

  // M1: durable plan plus execution artifacts.
  assert.equal((await state.writePlan({ planId, markdown: "# M4 plan\n\nEnd to end.\n" })).ok, true);
  assert.equal((await state.writeExecution({ planId, markdown: "# M4 execution\n\nSquad log.\n" })).ok, true);
  assert.equal((await state.readPlan(planId)).artifact.markdown, "# M4 plan\n\nEnd to end.\n");

  // M2: Developer steering submit.
  const submitted = await state.submitSteering({ planId, content: "M4 directive one." });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.entry.sequence, 1);
  assert.equal(submitted.entry.provenance.submitter, "developer");

  // M3: planning claims generation 1, records disposition before consume, consumes idempotently.
  assert.equal((await state.claimOwnership(ownershipClaim(planId))).ok, true);
  const check = await state.checkSteering({ planId, phase: "planning", session: "ses_m4_plan", generation: 1 });
  assert.equal(check.unread, 1);
  const read = await state.readSteering({ planId, phase: "planning", session: "ses_m4_plan", generation: 1 });
  assert.equal(read.entries.length, 1);
  assert.equal(
    (await state.recordSync({
      planId,
      phase: "planning",
      session: "ses_m4_plan",
      generation: 1,
      syncPoint: "pre-plan",
      disposition: "integrated",
    })).ok,
    true,
  );
  const consumed = await state.consumeSteering({
    planId,
    ids: [read.entries[0].id],
    phase: "planning",
    session: "ses_m4_plan",
    generation: 1,
    syncPoint: "pre-plan",
    disposition: "integrated",
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.checkpoint.highestContiguous, 1);
  assert.equal(consumed.consequentialAuthorization.anyConsequential, false);
  assert.equal(consumed.consequentialAuthorization.approvalsStillRequired, true);
  const idempotent = await state.consumeSteering({
    planId,
    ids: [read.entries[0].id],
    phase: "planning",
    session: "ses_m4_plan",
    generation: 1,
    syncPoint: "pre-plan",
    disposition: "integrated",
  });
  assert.equal(idempotent.ok, true);

  // Snapshot plus correction routing stay semantic and denied for consequential actions.
  const snapshot = await state.recordSnapshot({
    planId,
    phase: "planning",
    session: "ses_m4_plan",
    generation: 1,
    stage: "planning",
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.snapshot.consequentialAuthorization.anyConsequential, false);
  const routed = await state.routeCorrection({
    planId,
    phase: "planning",
    session: "ses_m4_plan",
    generation: 1,
    correction: "Sheepdog: narrow ownership and rerun deterministic checks before review.",
  });
  assert.equal(routed.ok, true);
  assert.equal(routed.correction.target, "sheepdog");

  // Handoff to governance on generation 2 revokes the planning owner.
  assert.equal(
    (await state.claimOwnership(ownershipClaim(planId, { phase: "governance", session: "ses_m4_gov", generation: 2, lifecycleState: "executing" }))).ok,
    true,
  );
  assert.equal(
    (await state.checkSteering({ planId, phase: "planning", session: "ses_m4_plan", generation: 1 })).error.code,
    "NOT_AUTHORITATIVE_PHASE",
  );
  assert.equal(
    (await state.checkSteering({ planId, phase: "governance", session: "ses_m4_gov", generation: 2 })).ok,
    true,
  );

  // Flocky layout holds every durable artifact for the plan.
  assert.equal(fs.existsSync(path.join(stateRoot(repo), "plans", `${planId}.md`)), true);
  assert.equal(fs.existsSync(path.join(stateRoot(repo), "executions", `${planId}.md`)), true);
  assert.equal(fs.existsSync(path.join(stateRoot(repo), "steering", planId, "checkpoint.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot(repo), "ownership", planId, "record.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot(repo), "ownership", planId, "sync.json")), true);
});

test("M4 fail closed conflicts across migration plus steering plus ownership", async () => {
  const repo = repository();
  const state = service({ cwd: repo.cwd });

  // Divergent legacy versus canonical bytes fail closed with both sides preserved.
  const splitId = "m4-split-plan";
  const legacyBytes = legacyArtifact(repo, "plan", splitId, "# Legacy version\n");
  const canonicalBytes = legacyArtifact(repo, "plan", splitId, "# Canonical version\n");
  seedLegacy(repo, "plans", splitId, legacyBytes);
  fs.mkdirSync(path.join(stateRoot(repo), "plans"), { recursive: true });
  const canonicalTarget = path.join(stateRoot(repo), "plans", `${splitId}.md`);
  fs.writeFileSync(canonicalTarget, canonicalBytes, "utf8");
  const split = await state.readPlan(splitId);
  assert.equal(split.ok, false);
  assert.equal(split.error.code, "MIGRATION_CONFLICT");
  assert.equal(split.error.conflicts[0].reason, "DIVERGENT_BYTES");
  assert.equal(fs.readFileSync(canonicalTarget, "utf8"), canonicalBytes);
  assert.equal(fs.readFileSync(path.join(legacyStateRoot(repo), "plans", `${splitId}.md`), "utf8"), legacyBytes);

  // Ambiguous targets fail closed with no repository-wide steering.
  const empty = await state.submitSteering({ content: "No target." });
  assert.equal(empty.error.code, "AMBIGUOUS_TARGET");
  await state.submitSteering({ planId: "m4-amb-a", content: "Seed A." });
  await state.submitSteering({ planId: "m4-amb-b", content: "Seed B." });
  const ambiguous = await state.submitSteering({ content: "Two targets." });
  assert.equal(ambiguous.error.code, "AMBIGUOUS_TARGET");
  assert.equal(ambiguous.error.retryable, false);

  // Owned target: non-owner, missing sync, raw record, and pending gating all fail closed.
  const planId = "m4-guarded-01";
  const submitted = await state.submitSteering({ planId, content: "Guarded directive." });
  assert.equal(submitted.ok, true);
  await state.claimOwnership(ownershipClaim(planId));
  assert.equal(
    (await state.checkSteering({ planId, phase: "governance", session: "ses_m4_gov", generation: 1 })).error.code,
    "NOT_AUTHORITATIVE_PHASE",
  );
  assert.equal(
    (
      await state.consumeSteering({
        planId,
        ids: [submitted.entry.id],
        phase: "planning",
        session: "ses_m4_plan",
        generation: 1,
        syncPoint: "continue",
        disposition: "integrated",
      })
    ).error.code,
    "SYNC_REQUIRED",
  );
  assert.equal(
    (
      await state.routeCorrection({
        planId,
        phase: "planning",
        session: "ses_m4_plan",
        generation: 1,
        correction: JSON.stringify({ sequence: 1, id: "st_abcdef1234567890", content: "raw" }),
      })
    ).error.code,
    "RAW_RECORD_REJECTED",
  );
  assert.equal(
    (
      await state.recordSync({
        planId,
        phase: "planning",
        session: "ses_m4_plan",
        generation: 1,
        syncPoint: "consequential-preparation",
        disposition: "integrated",
      })
    ).error.code,
    "PENDING_CONSEQUENTIAL_REQUIRED",
  );
  const sensitive = await state.claimOwnership(
    ownershipClaim("m4-sensitive-guard", { currentObjective: "reasoning transcript dump" }),
  );
  assert.equal(sensitive.error.code, "SENSITIVE_CONTENT_EXCLUDED");
});

test("M4 plugin integration preserves M1 through M3 through the existing tools", async () => {
  const repo = repository();
  const linked = linkWorktree(repo, "m4-linked-plugin");
  const mainHooks = await plugin({}, { state: { cwd: repo.cwd } });
  const linkedHooks = await plugin({}, { state: { cwd: linked.cwd } });
  const run = (hooks, name, agent, args) =>
    hooks.tool[name].execute(args, pluginContext(agent)).then((output) => JSON.parse(output));

  // M1 through the existing state tools: shepherd writes, governor and sheepdog read.
  const planId = "m4-plugin-e2e";
  assert.equal((await run(mainHooks, STATE_TOOLS.planWrite, "shepherd", { planId, markdown: "# M4 plugin plan\n" })).ok, true);
  assert.equal((await run(linkedHooks, STATE_TOOLS.planRead, "shepherd-governor", { planId })).ok, true);
  assert.equal((await run(linkedHooks, STATE_TOOLS.planRead, "sheepdog", { planId })).ok, true);
  assert.equal(
    (await run(linkedHooks, STATE_TOOLS.executionWrite, "sheepdog", { planId, markdown: "# M4 plugin execution\n" })).ok,
    true,
  );

  // M2 through the existing submission tool: developer only, explicit target, no CLI inference.
  assert.equal((await run(mainHooks, STEERING_TOOLS.submit, "developer", { planId, content: "Plugin directive." })).ok, true);
  assert.equal(
    (await run(mainHooks, STEERING_TOOLS.submit, "sheepdog", { planId, content: "Denied." })).error.code,
    "UNAUTHORIZED_AGENT",
  );

  // M3 through the existing ownership plus gated steering tools with fail closed conflicts.
  assert.equal(
    (
      await run(mainHooks, OWNERSHIP_TOOLS.claim, "shepherd", {
        planId,
        phase: "planning",
        session: "ses_m4_plugin",
        generation: 1,
        milestone: "m4-plugin-milestone",
        lifecycleState: "planning",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await run(linkedHooks, RAW_STEERING_TOOLS.check, "shepherd", {
        planId,
        phase: "planning",
        session: "ses_m4_plugin",
        generation: 1,
      })
    ).ok,
    true,
  );
  const deniedCheck = await run(linkedHooks, RAW_STEERING_TOOLS.check, "sheepdog", {
    planId,
    phase: "planning",
    session: "ses_m4_plugin",
    generation: 1,
  });
  assert.equal(deniedCheck.error.code, "UNAUTHORIZED_AGENT");
  const nonOwner = await run(linkedHooks, RAW_STEERING_TOOLS.read, "shepherd-governor", {
    planId,
    phase: "governance",
    session: "ses_m4_other",
    generation: 1,
  });
  assert.equal(nonOwner.error.code, "NOT_AUTHORITATIVE_PHASE");
  const unread = await run(linkedHooks, RAW_STEERING_TOOLS.read, "shepherd", {
    planId,
    phase: "planning",
    session: "ses_m4_plugin",
    generation: 1,
  });
  assert.equal(unread.entries.length, 1);
  assert.equal(
    (
      await run(mainHooks, OWNERSHIP_TOOLS.sync, "shepherd", {
        planId,
        phase: "planning",
        session: "ses_m4_plugin",
        generation: 1,
        syncPoint: "pre-plan",
        disposition: "integrated",
      })
    ).ok,
    true,
  );
  const consumed = await run(linkedHooks, RAW_STEERING_TOOLS.consume, "shepherd", {
    planId,
    phase: "planning",
    session: "ses_m4_plugin",
    generation: 1,
    ids: [unread.entries[0].id],
    syncPoint: "pre-plan",
    disposition: "integrated",
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.consequentialAuthorization.anyConsequential, false);
  assert.equal(consumed.consequentialAuthorization.approvalsStillRequired, true);
});
