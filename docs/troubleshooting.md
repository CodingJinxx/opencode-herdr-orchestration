---
title: Troubleshooting
layout: default
---

# Troubleshooting

Live-verified on `herdr 0.8.2` plus `opencode 1.18.29` plus package `0.3.2` plus `node v24.19.0` with `stable` Herdr channel and `opencode: current (v10)` integration. Every command below was executed before printing; live evidence wins over memory. Node requirement stays `>=20` per the package engines field, and the running `node v24.19.0` satisfies it. For full procedures see Installation, Upgrade, and Recovery instead of duplicating them here.

## Missing Herdr OpenCode integration

**Symptom:** `opencode agent list` misses one or more of `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, `shearer-medium`, or `herdr integration status` shows `opencode: not installed` instead of the healthy `opencode: current (v10)`.

**Cause:** The Herdr OpenCode integration is not installed, or OpenCode started before the plugin was configured. Agent and plugin configuration loads only at startup and the installer never restarts a running process.

**Check:** Run the read-only checks and compare with the healthy outputs observed live. `herdr integration status` shows `opencode: current (v10)`. `opencode agent list` lists all seven roles. `opencode debug agent shepherd` returns JSON with `"name": "shepherd"`. `node bin/orchestration.js status` reports all seven detected agents with `"agentsReady": true` plus matching installed and latest versions of `0.3.2` with `"updateAvailable": false`. On Windows PowerShell the `herdr` launcher resolves per `(Get-Command herdr).Source` to the Herdr `bin` exe verified as `herdr 0.8.2`. `herdr --help` lists `herdr integration <subcommand>` and `herdr integration install --help` lists `opencode` as a valid target.

**Fix:** Follow the Installation or Upgrade path for the install plus update flow, then quit and restart OpenCode intentionally when ready. Existing processes keep their already-loaded configuration. Do not hand-edit the global config while a dependent OpenCode process is running.

**Verify:** Repeat the check commands until `herdr integration status` shows `opencode: current (v10)`, `opencode agent list` shows all seven roles, `opencode debug agent shepherd` resolves `shepherd`, and `node bin/orchestration.js status` shows `"agentsReady": true`. When the integration stays missing, re-read Installation plus Upgrade instead of inventing new install spellings.

## Windows exe versus shim launcher resolution

**Symptom:** `opencode --version` reports an unexpected version, a process spawn fails with `%1 is not a valid Win32 application`, or `node bin/orchestration.js status` misses agents even though the config looks right.

**Cause:** On Windows PowerShell `opencode` may resolve to the direct exe (`node_modules/opencode-ai/bin/opencode.exe`) or to a shim (`opencode.cmd`, `opencode.ps1`, `opencode.exe` in the npm prefix) depending on `PATH` order. `PATH` here means the session `PATH` inspected read-only with `$env:PATH`. File-version text is not authoritative next to CLI `opencode --version` output `1.18.29`. Herdr panes inherit the Herdr server environment, not the current session `PATH`. A global `opencode upgrade` recreates the npm shims, so a previously durable order can flap back to shim-first with a bumped `opencode --version` versus `npm view opencode-ai version`.

**Check:** Inspect the resolver without changing it. `(Get-Command opencode).Source` shows the winning launcher. `(Get-Command opencode -All).Source` lists every candidate in order and reveals a reappearing shim after a global update. `(Get-Command herdr).Source` plus `(Get-Command herdr -All).Source` confirms Herdr resolves to a single `bin` exe with no shim confusion. Compare `opencode --version` against the full-path exe and shim forms; healthy hosts report the same `1.18.29` from each, while a bumped `opencode --version` against `npm view opencode-ai version` signals a recent global update. Confirm the process-spawn path with `Start-Process` using `-FilePath` from the resolved launcher plus `-ArgumentList --version -NoNewWindow -Wait`; live the extensionless shim fails with `%1 is not a valid Win32 application` while the direct exe reports `1.18.29`. Inspect order read-only with `$env:PATH`. Confirm the server split with `herdr status` showing `status: running` for `server` separate from client. For the read-only launcher report run `node bin/orchestration.js doctor`, which prints the winning launcher plus ordered candidates plus per-candidate versions plus agreement plus spawn probe plus integration presence plus flapping signals as JSON plus a human summary with operator-executed remedies. This package never overwrites the global environment. Config resolution only reads the environment in `src/installer.js:48` (`configDirectory`) and validation runs isolated with `OPENCODE_DISABLE_PROJECT_CONFIG` in `src/installer.js:594` (`validateOpenCode`), with status reporting in `src/installer.js:617` (`status`). Autoupdate context is `npm view opencode-herdr-orchestration version` reporting `0.3.2` matching `node bin/orchestration.js status` plus `herdr channel show` reporting `stable` plus `herdr update --help` describing the handoff option plus `opencode upgrade --help` listing upgrade targets and methods.

**Fix:** For current-session relief use the winning full exe path directly. For a durable fix apply a persistent user-chosen `PATH` reorder that places the direct exe directory before the npm shim directory, then restart Herdr plus the terminal plus OpenCode intentionally when ready, then follow Upgrade for the package update path. Session-local changes alone never fix Herdr spawns because panes inherit the Herdr server environment. This package never reorders global state automatically and never sets global environment values automatically; the persistent reorder is an operator-chosen Windows user environment change, not a package write. This package never overwrites the global environment and never sets global environment values automatically.

**Verify:** Repeat `opencode --version` through the resolved launcher until it reports `1.18.29` with exe and shim forms agreeing, repeat the `Start-Process` probe until the direct exe reports `1.18.29` without `%1 is not a valid Win32 application`, re-inspect `(Get-Command opencode -All).Source` for a reappearing shim plus `opencode --version` versus `npm view opencode-ai version` for a bumped version after any global `opencode upgrade`, confirm `opencode debug agent shepherd` returns `"name": "shepherd"`, and confirm `node bin/orchestration.js status` shows `"agentsReady": true`. A global `opencode` update recreates the npm shims, so a previously durable order can flap back to shim-first; re-inspect for a reappearing shim with a bumped `opencode --version` versus `npm view opencode-ai version`, and use `opencode upgrade` context only to explain the flap, instead of launcher reordering when the evidence points at permissions.

## Permission versus launcher routing

**Symptom:** Agents are still missing after the launcher checks look healthy, or it is unclear whether to reorder the launcher or repair permissions and configuration.

**Cause:** Launcher resolution and permission plus configuration faults share surface symptoms such as missing agents in `opencode agent list` or `"agentsReady": false` in `node bin/orchestration.js status`. Routing by the wrong cause wastes effort: reordering a healthy launcher never repairs a permission fault, and editing config never repairs a shim-first resolver.

**Check:** Route on the resolver evidence first. A launcher problem shows a `Source` mismatch in `(Get-Command opencode).Source` versus the direct exe, `%1 is not a valid Win32 application` from the `Start-Process` probe, candidate disagreement in `(Get-Command opencode -All).Source`, or a bumped `opencode --version` versus `npm view opencode-ai version`. A permission plus configuration problem shows the correct `Source` plus `opencode --version` `1.18.29` but `node bin/orchestration.js status` still reports missing agents or `"agentsReady": false`, or `opencode debug agent shepherd` fails while the resolver is healthy. Confirm Herdr itself is healthy with `(Get-Command herdr).Source` plus `herdr status` showing `status: running`, and confirm the package context with `npm view opencode-herdr-orchestration version` reporting `0.3.2`.

**Fix:** For launcher evidence follow the Windows exe versus shim launcher resolution fix above instead of editing permissions. For permission plus configuration evidence follow Installation plus Upgrade plus Recovery instead of launcher reordering, then quit and restart OpenCode intentionally when ready because existing processes keep old config.

**Verify:** The launcher route is done when exe and shim forms agree on `1.18.29` and the `Start-Process` probe succeeds. The permission route is done when `herdr integration status` shows `opencode: current (v10)`, `opencode agent list` shows all seven roles, and `node bin/orchestration.js status` shows `"agentsReady": true` with installed `0.3.2`.

## Recovery

All mutations are atomic and replayable; interruption leaves at most inert temps or a journal that the next call replays idempotently. Operator rule: retry `STEERING_BUSY` and `OWNERSHIP_BUSY` (both `retryable: true`); never hand-delete a live lock, journal, checkpoint, or guard.

- Steering submit: the journal (`queue.journal` via atomic rename) is written before the immutable entry install (exclusive create), then cleared. A crash leaves an inert temp, a journal that replays the submit idempotently, or a durable entry. A torn journal (invalid JSON) is discarded and the submitter retries with a new id; a valid journal whose entry already exists reports submit-already-durable; otherwise it is replayed. A stale per-target lock (older than 30 seconds) is taken over by modification time; a live lock waits up to 200 retries every 10 ms then fails with `STEERING_BUSY`, so retry the same call.
- Steering consume: the journal records the merged consumed ids before the checkpoint (`checkpoint.json` via atomic rename) advances, then is cleared. A crash replays the merged checkpoint idempotently; repeating the same ids returns the same highest contiguous value plus sorted consumed ids. A read before a consume never mutates, so a failure or restart between them leaves entries unread for any fresh service instance in any linked worktree.
- Ownership: `record.json`, `sync.json`, and snapshots are written via temp plus rename under the per-target `queue.lock` with the same 30 second stale takeover. Concurrent planning and governance contenders elect exactly one winner; losers fail with `STALE_GENERATION` and retry on the next generation. A live ownership lock waits the same bounded retry loop then fails with `OWNERSHIP_BUSY`, so retry the same call.
- Migration: an interrupted promotion leaves at most an inert uniquely-named staging temp. Later calls sweep only stale temps (older than 30 seconds), never a live contender's fresh temp, and revalidate the legacy source before completing the install idempotently. A corrupt canonical copy is repaired only by the holder of the per-artifact `.repairing` guard; a stale guard is taken over by modification time while a live guard makes contenders fail closed with `MIGRATION_CONFLICT` instead of unlinking a concurrent winner.
- Retryable transport faults such as `WRITE_FAILED`, `READ_FAILED`, `GIT_UNAVAILABLE`, `MIGRATION_STAGE_FAILED`, and `MIGRATION_PROMOTE_FAILED` (all `retryable: true`) mean retry the same read or write after the transient fault clears. Fail-closed conflicts such as `MIGRATION_CONFLICT` (`retryable: false`) mean halt and inspect the named paths below instead of retrying blindly.

## Legacy conflicts for operators

Reconciliation runs before every plan or execution operation and fails closed with structured `MIGRATION_CONFLICT` (`retryable: false`, with conflicts listing `artifactType`, `planId`, `reason`, `detail`, `legacyPath`, and `canonicalPath`); no artifact is selected or replaced on conflict. Both sides are preserved for manual review. This section covers what to inspect, not reconciler internals.

- `DIVERGENT_BYTES`: legacy and canonical copies are both valid but differ, or two contenders promoted different bytes and the loser byte-compared instead of overwriting. This also surfaces an active legacy write after a migration instead of last-writer-wins. Inspect the named `legacyPath` and `canonicalPath` and decide which whole file is authoritative.
- `CORRUPT_LEGACY_ARTIFACT`, `LEGACY_SCHEMA_MISMATCH`, `LEGACY_ARTIFACT_TYPE_MISMATCH`, `LEGACY_PLAN_ID_MISMATCH`, `LEGACY_IDENTITY_MISMATCH`, `LEGACY_INVALID_METADATA`, `LEGACY_INVALID_MARKDOWN`: the legacy source failed the same validation a canonical write requires (schema 1, matching type and plan ID, current repository identity, valid top level plus timestamps, non-empty Markdown within 1 MiB). Inspect the named `legacyPath` for the cited field and repair or drop only that side after review. Nothing is promoted on these reasons.
- `INVALID_PLAN_ID`: the legacy file name is not a valid plan ID. Inspect the file name at the named `legacyPath`; canonical path is empty on this reason.
- `CONCURRENT_REPAIR`: another contender holds a live repair guard for a corrupt canonical target. Wait for that repair to settle, then retry; do not remove the `.repairing` guard by hand.

Identical bytes are accepted untouched; disjoint plan IDs migrate independently without dropping either; valid legacy-only artifacts are staged from freshly validated bytes and installed through the atomic exclusive create that is the single linearization point. To resolve: inspect the named `legacyPath` and `canonicalPath`, decide which whole bytes are authoritative, make the copies byte-identical or remove the stale side only after review, then retry. The legacy root is never auto-deleted.

## Docs navigation

- [Home](./)
- [Getting Started](./getting-started.html)
- [CLI Reference](./cli-reference.html)
- [Configuration](./configuration.html)
- [Troubleshooting](./troubleshooting.html)
- [Architecture](./architecture.html)
- [Contributing](./contributing.html)
- [Changelog](./changelog.html)
