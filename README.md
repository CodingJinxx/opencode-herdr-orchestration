# opencode-herdr-orchestration

Capability-separated OpenCode agents for planning, implementation, independent review, and delivery through Herdr, organized as **Developer → Shepherd → Flock**.

This package registers the agents, provides complete structured worker-response retrieval, injects session-specific orchestration mode into shell environments, and ships a reproducible Git `pre-push` policy for new and existing repositories.

Requires Node.js 20 or newer when running the package CLI or tests.

## Philosophy

There is exactly **one Developer: the human operator**, and the Developer sits above the Shepherd. The Developer owns intent, product judgment, risk tolerance, and every final approval. No agent replaces the Developer; the Shepherd and every agent below it only prepare decisions for the Developer.

The Developer works through the Shepherd's two **technical phases**, each a registered agent:

- `shepherd` — the **planning** phase. Researches the repository through read-only workers and presents implementation-ready plans. It never implements.
- `shepherd-governor` — the **governance** phase. Approves plans by taking over the session, contracts bounded work, judges semantics — integrated results, review verdicts, and escalations — and owns everything remote: pushes, merges, PRs, and delivery.

The **Flock** is the bounded workforce herded under those phases:

- `sheepdog` — herds the working flock: prepares worker branches and worktrees, drives worker delegation, watches progress, retries and re-contracts leaves, runs deterministic validation, selects the shearer review tier, recovers conflicts by re-scoping ownership, and performs local integration of worker output under the governor's contracts.
- `grazer` — read-only research workers that graze the repository for evidence.
- `sheep` — bounded implementation workers that produce verified local commits.
- `shearer-low` / `shearer-medium` — independent read-only reviewers.

Three invariants govern the whole system:

1. **Authority flows down, never sideways or up.** Each role may mutate only what its authority permits. A worker cannot delegate beyond its assignment; a reviewer cannot mutate; the flock cannot deliver.
2. **Results flow up through structured channels.** Shepherd-phase agents act on settled, paginated responses and committed artifacts — never on terminal scrollback, partial state, or a worker's reasoning transcript.
3. **Approval never flows down implicitly.** Reaching a milestone never grants authority, and the Developer's acknowledgement of a plan is a separate, explicit control.

## Topology

```text
Developer (the human operator, one per flock)
│
├── Planning phase: shepherd
│   └── grazer                          read-only research
│
└── Governance phase: shepherd-governor
    ├── grazer                          read-only research
    └── sheepdog                        herds the working flock
        ├── sheep                       bounded implementation
        ├── shearer-low                 independent review, low reasoning
        └── shearer-medium              independent review, medium reasoning
```

### Governor prompt scoping residual

`shepherd-governor` prompts only `grazer` and `sheepdog` workers it spawned. Direct Shepherd to Sheep task management is forbidden even as recovery: neither `shepherd` nor `shepherd-governor` may spawn, prompt, wait on, or retrieve `sheep` or shearer workers directly when a worker is unavailable, blocked, or denied. Name-based prompt patterns cannot encode worker role, so governor `herdr agent prompt` plus `wait` plus `get` plus `read` patterns stay broad as far as text matchers permit. Prompt bans plus start denial plus the response matrix are the load-bearing layers: start denial allows only `grazer` and `sheepdog` creation and the response matrix allows only `grazer` and `sheepdog` retrieval. A denied lifecycle operation must produce `STOP` plus an explicit configuration failure report naming the missing capability, with never any auto fallback to direct sheep execution. `sheepdog` remains the sole supervisor of leaves and the sole path for bounded recovery contracts.

## Pane layout policy (14-18-M1)

This is the single normative pane policy. It binds only to live-evidenced installed `0.8.2` syntax from full-path `herdr --help` plus `herdr --skill` plus scoped read-only `pane list --workspace w1K` plus `tab list --workspace w1K` plus `pane current --current` plus `pane layout --current` plus `agent get issue1418m1sheep` plus `pane get w1K:p999` error sampling; direct `herdr ...` spelling stays denied for leaves and discovery never split plus renamed plus closed plus started layout. Never invent `herdr pane create*`, `herdr tab split*`, `herdr agent events*`, `herdr pane move*`, `herdr pane resize*`, `herdr workspace create*` behavior. If any primitive below is missing, reuse the current pane via `--pane` plus `--current` and report `STOP` naming the missing capability with preserved state.

Four-pane cap: at most four panes per tab including the caller pane. Count with `herdr tab list --workspace "$HERDR_WORKSPACE_ID"` (`{"id":"cli:tab:list","result":{"tabs":[{"pane_count":1,"tab_id":"w1K:t1",...}]},"type":"tab_list"}`), or `herdr pane list --workspace "$HERDR_WORKSPACE_ID"` (`{"id":"cli:pane:list","result":{"panes":[{...,"pane_id":"w1K:p1","tab_id":"w1K:t1","workspace_id":"w1K",...}]},"type":"pane_list"}` filtered by tab plus workspace), or `herdr pane layout --current` (`{"id":"cli:pane:layout","result":{"layout":{"panes":[...],"splits":[],"focused_pane_id":"w1K:p1",...}},"type":"pane_layout"}`). Never split when the filtered count is already four; use indexed overflow instead. Never create a workspace or tab to evade the cap: `herdr tab create*`, `herdr tab close*`, `herdr tab get*`, `herdr tab focus*`, `herdr tab rename*` stay denied for every role and `herdr workspace create*` is never used for layout (skill default is a sibling pane in the current tab with the current working directory).

Role grouping: one `Sheepdog` pane hosts the single `sheepdog` worker started by `shepherd-governor`; flock panes host `sheepdog` squad workers (`grazer`, `sheep`, `shearer-low`, `shearer-medium`) grouped by role with indexed labels (`Sheepdog`, `sheep-1`, `sheep-2`, `shearer-low-1`, `grazer-1`). Label with evidenced `herdr pane rename <PANE_ID> [LABEL]...` plus `herdr agent rename <TARGET> <NAME>` (live `agent list` plus `agent get` expose `name` such as `issue1418m1sheep` plus `pane_id`); `herdr tab rename*` stays denied and tabs keep their existing labels. `shepherd` manages its single `Sheepdog` pane scan plus placement plus rename only; `shepherd-governor` manages its single `Sheepdog` pane scan plus placement plus rename only; `sheepdog` manages flock panes scan plus placement plus rename plus close up to the cap; leaves (`grazer`, `sheep`, `shearer-low`, `shearer-medium`) gain no pane plus tab plus rename commands and stay unchanged.

Indexed overflow: when the cap is reached, overflow by index within role grouping instead of creating a fifth pane. Reuse `sheep-1` for the next `sheep` assignment, `shearer-low-1` for the next low review, and so on, after confirming idle plus done via `herdr agent get <name>` (`{"id":"cli:agent:get","result":{"agent":{...,"name":"issue1418m1sheep","pane_id":"w1K:p1",...}},"type":"agent_info"}`) plus `herdr pane read <PANE_ID> --source recent-unwrapped --lines 120`. Never derive IDs from sidebar order or examples; parse them from JSON responses.

Reuse before create: before every split, scan for a reusable pane for the same role (idle plus done plus clean plus same cwd when possible) with `herdr pane list --workspace`, `herdr tab list --workspace`, `herdr pane current --current` (`{"id":"cli:pane:current","result":{"pane":{...}},"type":"pane_current"}`), `herdr pane layout --pane "$HERDR_PANE_ID"`, `herdr pane get <pane_id>`, `herdr agent get <name>`, and `herdr pane read` for live status. Reuse the matching pane when found; split only when no reusable pane exists and the cap permits. `herdr pane move*`, `herdr pane focus*`, `herdr pane resize*`, `herdr pane swap*`, `herdr pane neighbor*`, `herdr pane edges*` stay denied for every role; choose split direction from layout geometry instead of moving plus resizing.

Startup destinations: start in the calling pane (`$HERDR_PANE_ID` via `--current`) and never rely on another client focused pane. `shepherd` starts its `grazer` in a sibling pane of the current tab; `shepherd-governor` starts its `sheepdog` in a dedicated sibling `Sheepdog` pane of the current tab; `sheepdog` starts in its own `Sheepdog` pane (where the governor started it via `--pane`) and starts flock workers in sibling flock panes of the same tab. Every start uses the existing spawn matrix exactly (`herdr agent start <name> --kind opencode --pane <pane-id> -- --agent <role>` with unique `[a-z][a-z0-9_-]{0,31}` names); the pane must be at its interactive shell prompt and success means Herdr detected the expected agent ready for input. Caller context is `$HERDR_WORKSPACE_ID` plus `$HERDR_TAB_ID` plus `$HERDR_PANE_ID` with opaque stable IDs (`w1K`, `w1K:t1`, `w1K:p1`); closed IDs are never reused and a moved pane would receive a new ID via `.result.move_result.pane.pane_id` (move stays denied and is cited only for ID stability).

Ownership: only the creator may rename plus close its panes and only after commits are integrated or otherwise preserved and the worktree is clean; never close plus rename plus reuse another owner pane. `shepherd` owns its single `Sheepdog` pane scan plus split plus rename and never closes; `shepherd-governor` owns its single `Sheepdog` pane scan plus split plus rename and never closes flock panes; `sheepdog` owns flock pane scan plus split plus rename plus `herdr pane close <pane_id>` for panes it created and never force-removes. Never run `herdr server stop` from an active session and never close workspaces plus tabs plus sessions not created by the caller unless the user explicitly asked.

Protected Dev Developer Terminal exclusion: the pane labeled `Dev` (`Developer Terminal`) is excluded from every scan plus split plus placement plus rename plus close plus reuse. Never count it toward the four-pane cap, never list it as a reuse candidate, never split from it or into it, never place a worker there, never rename it, never close it, and never reuse it for overflow. Filter it during scan by `terminal_title` plus `terminal_title_stripped` plus `label` before counting plus reusing; when only the Dev pane would satisfy reuse, treat reuse as absent and either split elsewhere within cap or report `STOP` with preserved state. This exclusion is prompt plus policy enforced with an honest matcher residual below.

Six-step placement (single-tab, reuse-first, evidence-only): 1. Scan the current workspace plus tab with `herdr tab list --workspace`, `herdr pane list --workspace`, `herdr pane current --current`, and `herdr pane layout --pane` (or `--current`), filtering Dev out before counting. 2. Cap check against four; on cap, go to indexed overflow reuse and never split. 3. Reuse check for the same role with `herdr pane get` plus `herdr agent get` plus `herdr pane read`; on hit, reuse that pane ID and skip to step 6. 4. Split with `herdr pane split --current --direction right/down --cwd "$PWD" --no-focus` (wide to the right, narrow or tall down per `herdr pane layout` area, preserving cwd and keeping caller focus) and read the new pane ID from `.result.pane.pane_id` (`tab create` would return `.result.tab` plus `.result.root_pane` but is never used for layout). 5. Rename with `herdr pane rename <pane> <role-index>` plus `herdr agent rename <target> <name>` after start (or `--clear` only for owned panes being released), never touching Dev. 6. Start with the spawn matrix `herdr agent start <name> --kind opencode --pane <pane-id> -- --agent <role>` and then prompt plus wait plus get plus read plus retrieve via `herdr_agent_response` until complete. Most controls return JSON on stdout with `id` plus `result` plus `type`; server errors are JSON on stderr with exit 1 (live `pane get w1K:p999` returns `{"error":{"code":"pane_not_found","message":"pane w1K:p999 not found"},"id":"cli:pane:get"}`); syntax plus validation such as `pane split --direction invalid` returning `invalid split direction` exits with 2 per `herdr --skill`.

Pane layout residual: Bash matchers are string globs and cannot prove pane label plus role plus ownership plus count, so `herdr tab list*`, `herdr pane get*`, `herdr pane rename*`, `herdr agent rename*` (shepherd plus governor single plus sheepdog flock) and `herdr pane close*` (sheepdog flock only) stay broad as far as text matchers permit; no `*Dev*` glob is added because it would overmatch legitimate `--cwd C:\Dev\...` values and labels are absent from scan plus split plus close strings. Prompt bans plus spawn denial (shepherd allows only `grazer`, governor allows only `grazer` plus `sheepdog`, sheepdog allows only `grazer` plus `sheep` plus shearers) plus the response matrix plus this policy are the load-bearing layers; a crafted rename plus close that matches an allow glob but targets Dev remains possible and the scan plus reuse plus never-Dev rule stays primary, mirroring the send-keys Ctrl-C plus governor prompt residuals.

File and line references: tab plus pane plus rename allows in `src/agents.js` (`SHEPHERD_PANE_ALLOWS`, `GOVERNOR_PANE_ALLOWS`, `SHEEPDOG_PANE_ALLOWS`); spawn matrix in `src/agents.js` (`spawnMatrix`); authoritative CLI in installed `herdr --help`, `herdr tab --help`, `herdr pane --help`, `herdr agent --help`, `herdr pane split --help`, `herdr pane move --help`, `herdr pane rename --help`, `herdr pane close --help`, `herdr pane list --help`, `herdr pane layout --help`, `herdr pane current --help`, `herdr pane get --help`, `herdr pane read --help`, `herdr tab list --help`, `herdr tab create --help`, `herdr tab rename --help`, `herdr tab close --help`, `herdr tab get --help`, `herdr agent rename --help`, `herdr agent start --help`, `herdr agent list --help`, `herdr agent get --help`, plus `herdr --skill` for JSON plus ID plus geometry plus exit rules.

## Startup layout plus dynamic placement (14-18-M2)

M2 teaches every spawning role the shared M1 normative pane policy with role-specific ownership plus capacity plus grouping naming plus reuse versus create plus user tab avoidance, citing the same normative wording as the Pane layout policy section so prompts and runtime cannot drift. M1 stays normative with no rework; spawn plus response plus state matrices stay intact with no new spawn targets; leaves stay unchanged with no pane commands.

Shared normative paragraph carried verbatim in shepherd plus shepherd-governor plus sheepdog prompts:

Pane layout policy (single normative policy, same wording as README): Four-pane cap: at most four panes per tab including the caller pane. Never split when the filtered count is already four; use indexed overflow instead. Overflow by index within role grouping instead of creating a fifth pane. Grouped by role with indexed labels (Sheepdog, sheep-1, sheep-2, shearer-low-1, grazer-1); tabs keep their existing labels. Reuse the matching pane when found; split only when no reusable pane exists and the cap permits. Reuse is preferred over clutter: reuse a capacity-available managed pane for the same role before splitting. Never derive IDs from sidebar order or examples; parse them from JSON responses. The pane labeled Dev (Developer Terminal) is excluded from every scan plus split plus placement plus rename plus close plus reuse. Never count it toward the four-pane cap, never list it as a reuse candidate, never split from it or into it, never place a worker there, never rename it, never close it, and never reuse it for overflow. Filter it during scan by terminal_title plus terminal_title_stripped plus label before counting plus reusing; when only the Dev pane would satisfy reuse, treat reuse as absent and either split elsewhere within cap or report STOP with preserved state. Never create a workspace or tab to evade the cap. Start in the calling pane and never rely on another client focused pane. If any primitive below is missing, reuse the current pane via --pane plus --current and report STOP naming the missing capability with preserved state. Pre-create default stays minimal: reuse the current pane via --pane plus --current when primitives are missing. On finish, reuse the pane for the next same-role assignment after confirming idle plus done. Six-step placement is single-tab plus reuse-first plus evidence-only. Dynamic placement follows the same single normative pane policy with no separate rulebook.

Pinned shared sentences (each appears verbatim above and in all three spawning prompts, so divergence fails):

- at most four panes per tab including the caller pane
- Never split when the filtered count is already four; use indexed overflow instead.
- Overflow by index within role grouping instead of creating a fifth pane.
- Grouped by role with indexed labels (Sheepdog, sheep-1, sheep-2, shearer-low-1, grazer-1)
- tabs keep their existing labels
- Reuse the matching pane when found; split only when no reusable pane exists and the cap permits.
- Reuse is preferred over clutter
- Never derive IDs from sidebar order or examples; parse them from JSON responses.
- excluded from every scan plus split plus placement plus rename plus close plus reuse
- Never count it toward the four-pane cap, never list it as a reuse candidate, never split from it or into it, never place a worker there, never rename it, never close it, and never reuse it for overflow.
- Filter it during scan by terminal_title plus terminal_title_stripped plus label before counting plus reusing
- when only the Dev pane would satisfy reuse, treat reuse as absent and either split elsewhere within cap or report STOP with preserved state.
- Never create a workspace or tab to evade the cap
- Start in the calling pane and never rely on another client focused pane.
- If any primitive below is missing, reuse the current pane via --pane plus --current and report STOP naming the missing capability with preserved state.
- Pre-create default stays minimal
- On finish, reuse the pane for the next same-role assignment after confirming idle plus done.
- Six-step placement is single-tab plus reuse-first plus evidence-only
- Dynamic placement follows the same single normative pane policy with no separate rulebook.

Role ownership plus startup destinations (same cap plus exclusion rules, pre-create default minimal):

- shepherd manages its single Sheepdog pane scan plus placement plus rename only and never closes; starts its grazer in a sibling pane of the current tab.
- shepherd-governor manages its single Sheepdog pane scan plus placement plus rename only and never closes flock panes; starts its sheepdog in a dedicated sibling Sheepdog pane of the current tab.
- sheepdog manages flock panes scan plus placement plus rename plus close up to the cap; only the creator may rename plus close its panes and only after commits are integrated or otherwise preserved and the worktree is clean; starts in its own Sheepdog pane and starts flock workers in sibling flock panes of the same tab grouped by role with indexed labels; startup destinations for grazer plus sheep plus shearer-low plus shearer-medium worker categories stay within the four-pane cap with Dev excluded and pre-create default minimal.

Six-step dynamic placement with four-pane boundary (same policy, no separate rulebook): single-tab plus reuse-first plus evidence-only with cap check plus reuse check plus split plus rename plus start; on cap go to indexed overflow reuse and never split; reuse capacity-available managed panes first and reuse the pane on finish after confirming idle plus done; never create a new tab or workspace to evade the cap. Boundary behavior: four-pane overflow reuses the indexed role label instead of a fifth pane; reuse is preferred over clutter; the Dev Developer Terminal pane is never renamed split closed reused or modified across initial plus dynamic plus focused plus empty tab cases; Sheepdog startup destinations stay within the cap.

File and line references: shared sentences plus paragraphs plus pure placement helpers in `src/prompts.js` (`PANE_CAP`, `PANE_POLICY_SHARED_SENTENCES`, `PANE_POLICY_SHARED_PARAGRAPH`, `SHEPHERD_PANE_OWNERSHIP_PARAGRAPH`, `GOVERNOR_PANE_OWNERSHIP_PARAGRAPH`, `SHEEPDOG_PANE_OWNERSHIP_PARAGRAPH`, `isDevPane`, `managedPanes`, `managedPanesInTab`, `preCreateDefaultPane`, `nextRoleLabel`, `decidePanePlacement`, `sheepdogStartupDestination`); prompt assertion tests in `test/m2-prompt-policy.test.js`; boundary tests in `test/m2-placement-boundary.test.js`.

## Roles and authorities

| Agent | Tier | Direct mutation | Spawns | Git authority |
| --- | --- | --- | --- | --- |
| `shepherd` | Strong (inherits active model) | Markdown plans, research notes, task briefs, handoffs | `grazer` only | Local Markdown commits only; no push |
| `shepherd-governor` | Strong (inherits active model) | Markdown briefs, handoffs, review notes | `grazer`, `sheepdog` | Integration, push, PR, merge, delivery |
| `sheepdog` | Fast worker (`litellm/glm-5.3-flash`) | None | `grazer`, `sheep`, `shearer-low`, `shearer-medium` | Local integration of worker output; no push |
| `grazer` | Fast worker (`litellm/glm-5.3-flash`) | None | None | Read-only inspection |
| `sheep` | Fast worker (`litellm/glm-5.3-flash`) | Assigned implementation | None | Local task commit only |
| `shearer-low` | Reviewer (`litellm-responses/gpt-5.6-terra`, low) | None | None | Read-only inspection |
| `shearer-medium` | Reviewer (`litellm-responses/gpt-5.6-terra`, medium) | None | None | Read-only inspection |

Model tiers are deliberate. The two shepherd-phase agents run on the active strong model and inherit its reasoning behavior, because planning and governance are the judgment-heavy work. Flock workers run on a fast, cheap model because their tasks are bounded and their outputs are validated. Shearers run a dedicated independent model at fixed `low` and `medium` reasoning so review is never the same model grading its own family's homework.

Sheepdog chooses `shearer-low` for localized mechanical changes with strong deterministic coverage. It chooses `shearer-medium` for security, architecture, migrations, public APIs, deployment, concurrency, cross-component work, weak coverage, or material uncertainty.

## Governing controls

### Separate acknowledgement and milestone controls

Acknowledgement and progress are intentionally different mechanisms:

- **Acknowledgement** is the act of selecting `shepherd-governor` in the session. Switching from the planning phase to the governance phase approves the latest presented plan. Nothing else — not a worker finishing, not a check passing, not time passing — approves a plan.
- **Milestones** track progress: the plan header (`Plan-ID`, `Base-Commit`, `Status`), each `task_id` contract, each verified local task commit, and each review verdict.

Milestones never imply acknowledgement, and acknowledgement never auto-advances a milestone. Governance-phase startup reports the plan ID, approved base, and current HEAD, then inspects divergence from the approved base before delegating.

Before acknowledging any task contract, the sheepdog reads the authoritative plan artifact itself with `herdr_plan_read` using the contract's plan ID — never a secondhand summary — and replans when the contract contradicts what the plan artifact says.

Final plans carry:

```text
Plan-ID: <short-project-topic>-<YYYYMMDD>-<sequence>
Base-Commit: <full commit hash>
Status: PROPOSED
```

### Worker reply protocol

Worker replies are keyword-prefixed structured messages with two distinct channels:

- **Acknowledgement replies** open a coordinator's first response to a task contract: `ACK` (contract accepted, work starting), `CORRECT` (contract must be corrected first), `REPLAN` (contract conflicts with the approved plan or repository evidence), or `STOP` (blocked outright). Only the sheepdog — a squad lead, not a leaf — sends an acknowledgement turn, and only to the governor.
- **Leaf workers work directly.** Grazer, sheep, and shearers start their assignments without an acknowledgement turn. If a leaf cannot start, its first reply begins with `CORRECT`, `REPLAN`, or `STOP`.
- **Milestone replies** report completed milestones: `CONTINUE` (ready for the next milestone), `CORRECT` (defects need correction within the current task), `REPLAN` (evidence invalidates the plan; escalation for re-planning), `STOP` (blocked after a milestone), or `FINALIZE` (all milestones complete, final report follows).

`FINALIZE` closes a task and is never an acknowledgement. `CORRECT`, `REPLAN`, and `STOP` are legal on either channel.

### No chain of thought

Shepherd-phase agents govern by contracts and results, not by reading worker reasoning. The `herdr_agent_response` tool returns only the latest completed final assistant message: intermediate tool-call steps, errors, ignored text, reasoning, and terminal rendering are excluded at the source. Shearers likewise receive fresh bounded context — user goal, approved plan, task contract, base and implementation commits, diff, and verification results — never the worker conversation.

This keeps delegation bounded, keeps review independent, and keeps a shepherd-phase agent's context small enough to govern many workers.

### Deterministic validation

Before requesting semantic review, sheepdog runs or delegates deterministic repository-native checks (the repository's own check and test commands) and owns retrying deterministic failures back to the responsible sheep. Shearers judge semantics and defects; deterministic coverage is confirmed first so review cycles are never spent discovering what a test would have caught.

### Review

Shearer verdicts are:

- `PASS`: integrate after governor checks.
- `REWORK`: return actionable findings to the responsible sheep and review the correction.
- `ESCALATE`: research, re-plan, or request Shepherd judgment.

Two failed semantic review cycles for the same task escalate instead of looping indefinitely.

### Escalation

Task contracts carry explicit `escalate_if` conditions. Flock workers must escalate rather than guess when evidence contradicts the assignment, ownership must expand, a public API or migration changes unexpectedly, a product or architecture decision is needed, permissions block required work, or repeated attempts fail. Shepherd-phase agents resolve what repository evidence permits and surface unresolved product choices to the Developer — the human — for judgment. `unknown` is treated as inconclusive, never complete.

### Local integration and conflict delegation

Sheepdog owns the execution mechanics end to end: it prepares each parallel `sheep` worker a dedicated branch and worktree with non-overlapping ownership and an explicit integration order, performs local integration of worker output under the governor's contracts using a narrow merge and cherry-pick lifecycle (`git merge --ff-only`, `git merge --no-ff --no-edit`, `git cherry-pick`, and their continue/abort/quit forms), and owns conflict recovery: on any conflict it aborts immediately, re-inspects, recovers by re-scoping ownership or issuing bounded recovery tasks to the responsible sheep, and escalates when conflicts invalidate the plan, repeat, or exceed its authority. Sheepdog never hand-edits a conflicted file. The governor judges the result semantically — mechanical drift is reported as deviations, and it returns defects to sheepdog rather than editing implementation itself. No flock role pushes, opens PRs, or delivers; all integration stays local until the delivery authority pushes.

## State storage

All durable orchestration state lives outside agent memory and plugin process state, in two places:

- **The constrained orchestration state API.** Four plugin tools store and retrieve Markdown artifacts with JSON frontmatter under the repository's shared Git common directory: `herdr_plan_write` for plan artifacts (the planning shepherd only), `herdr_plan_read` for plan artifacts (shepherd, shepherd-governor, and sheepdog), and `herdr_execution_write` and `herdr_execution_read` for execution artifacts (sheepdog). Sheepdog and the governor may read the authoritative plan but never write one; plan authorship stays with the planning shepherd. Artifacts live at the canonical `<git-common-dir>/flocky/plans/<planId>.md` and `<git-common-dir>/flocky/executions/<planId>.md`. Writes are atomic; the service invokes only read-only `git rev-parse`; Markdown bodies are capped at 1 MiB; plan IDs are 1–64 characters of letters, digits, dot, underscore, or hyphen.
- **Legacy `herdr` migration.** The previous `<git-common-dir>/herdr` root is retained as a compatibility source only: it is never auto-deleted and never acts as a second canonical authority. Before every plan or execution read/write the service reconciles the legacy root into the canonical Flocky root without any lock or shared journal — legacy-only artifacts are validated, staged to a unique temp, and installed through an atomic exclusive create, which is the single linearization point (preserving valid legacy artifacts such as plan ID `developer-steering-flocky-state-20260901-01`); a lost install race re-reads the winner and byte-compares instead of overwriting; a corrupt canonical copy is repaired only by the holder of a per-artifact repair guard, and any contender that cannot claim the guard — or observes an unexpected state inside it — fails closed instead of overwriting, so at most one contender reports a migration while losers receive a structured `MIGRATION_CONFLICT`; byte-identical copies are accepted; divergent valid copies fail closed with a structured `MIGRATION_CONFLICT` (no silent selection or replacement, so an active legacy write is surfaced instead of lost to last-writer-wins). An interrupted promotion leaves at most an inert staging temp, and any later call revalidates the legacy source and completes the install idempotently.
- **Git history.** Shepherd-phase agents may commit intended Markdown planning artifacts locally, and worker output is a verified local commit; progress is Git history, reviewable and revertable.

Every worker worktree sheepdog creates — including worktrees created from other worktrees — is a **peer that shares the same Git common repository**, never a nested checkout. Because the state API stores artifacts under the common directory, a plan written in one worktree governs workers in all of them, and orchestration state survives session ends, process restarts, and machine reboots. Separate clones never share this state.

Everything not stored this way is explicitly ephemeral: `SHEPHERD_MODE` is injected per OpenCode session and dies with the session; response cursors are HMAC-signed with a per-plugin-process secret, expire after six hours, and do not survive a restart of the shepherd's OpenCode plugin process.

## Git authority

| Mode | Hook behavior |
| --- | --- |
| Planning phase (`shepherd`) | Denies every push; delivery belongs to the governance phase |
| Governance phase (`governor`) | Allows only the current attached branch pushed to the same remote branch |
| Flock workers (sheepdog, grazer, sheep) | Denies every push |
| Shearers (shearer-low, shearer-medium) | Denies every push |
| Missing/unknown | Does not interfere with normal human Git use |

The hook rejects pushes from detached HEAD in governance mode, protected branches, ref renames, unrelated refs, and remote ref deletions. In governance mode `main` and `master` are always protected; add repository-specific branches:

```bash
git config --add orchestration.protectedBranch production
git config --add orchestration.protectedBranch release
```

### Security boundary

The hook and OpenCode Bash matchers are defense in depth, not a security sandbox. A process with arbitrary local command execution may be able to alter environment variables, Git configuration, hooks, or invoke remote protocols outside ordinary `git push`. Keep server-side protected branches and repository permissions as the authoritative control. A future integration can strengthen mode provenance with signed, session-scoped policy data, but cannot replace remote authorization.

## Response topology

The `herdr_agent_response` OpenCode tool retrieves completed responses from Herdr-managed OpenCode workers without reading terminal scrollback or creating response files. Only `shepherd`, `shepherd-governor`, and `sheepdog` may call it, with a second role allowlist check inside the tool, and only for settled Herdr targets with a trusted `herdr:opencode` session mapping and an approved role. Each caller may retrieve only from its own workers: `shepherd` from `grazer`; `shepherd-governor` from `grazer` and `sheepdog`; `sheepdog` from `grazer`, `sheep`, `shearer-low`, and `shearer-medium`.

Initial call:

```json
{
  "target": "frontend_worker",
  "maxBytes": 8192
}
```

Continuation call:

```json
{
  "cursor": "<opaque-signed-cursor>",
  "maxBytes": 8192
}
```

Successful page:

```json
{
  "ok": true,
  "target": "frontend_worker",
  "sessionID": "ses_...",
  "messageID": "msg_...",
  "role": "sheep",
  "finish": "stop",
  "offset": 0,
  "nextOffset": 8192,
  "totalBytes": 24500,
  "complete": false,
  "cursor": "<opaque-signed-cursor>",
  "text": "..."
}
```

Shepherd-phase agents must continue until `complete` is true before acting on the response. Pages use UTF-8 byte offsets and never split a multibyte character.

The tool:

- resolves Herdr's tracked OpenCode session ID;
- runs `opencode export <sessionID>` with an argv API rather than shell interpolation;
- selects the latest completed final assistant message after the latest user prompt;
- excludes intermediate tool-call steps, errors, ignored text, reasoning, and terminal rendering;
- pins continuation reads to the original session, message, response digest, and offset;
- HMAC-signs opaque cursors with a random per-plugin-process secret;
- paginates on UTF-8-safe boundaries with a bounded tool-output budget;
- supports concurrent shepherds without response files or shared mutable retrieval state.

The export backend is intentional. Herdr starts each worker as a separate OpenCode process, so the shepherd plugin's SDK client may be tied to a different OpenCode server. `opencode export` reads the shared OpenCode session store across those process boundaries.

Normal lifecycle failures return structured errors such as:

```json
{
  "ok": false,
  "error": {
    "code": "AGENT_NOT_SETTLED",
    "message": "Herdr agent frontend_worker is working; wait for idle or done.",
    "retryable": true
  }
}
```

Cursor continuations do not query Herdr again, so a worker may begin another turn or leave the live agent list after the initial page. The response remains pinned as long as the OpenCode session and message still exist and are unchanged. Cursors expire after six hours by default and do not survive a restart of the shepherd's OpenCode plugin process.

### Responsive wait mechanics (20-M1)

Waits use a bounded `herdr agent get` poll loop on a short interval (about 10 seconds) with no invented event stream: `working` means continue, `idle`/`done` means retrieve via `herdr_agent_response` until `complete` is true, `blocked` means inspect with `get` plus `read` then decide with never blind input. Start/prompt command failures surface immediately with their distinct code instead of decaying to timeout; disappearance (`agent_not_found`, vanished from `herdr agent list`) gets an explicit report; safety timeout stays the final bound only as `WAIT_TIMEOUT_EXPIRED`. Distinct codes are `AGENT_NOT_SETTLED`, `AGENT_BLOCKED`, `AGENT_ERROR`, `AGENT_NOT_FOUND`, `HERDR_UNAVAILABLE`, and `WAIT_TIMEOUT_EXPIRED`; retries stay bounded and `unknown` stays inconclusive. Sheepdog owns routine flock waits with no per-transition Shepherd wakeups.

### Operational diagnostics (20-M2)

Chosen strategy is a process-local bounded in-memory ring buffer with no filesystem, no Git, no Herdr commands, no plugin tools, and no persistence. Entries are ephemeral like `SHEPHERD_MODE` and response cursors: they do not survive a plugin restart and must never substitute for authoritative retrieval. The mechanism needs no Herdr side features, no config format changes, no installer changes, and no CLI changes; it is a standalone `src/diagnostics.js` helper that is never wired into the M1 wait loop or the response path.

Lightweight operational event records cover exactly eight types: `worker-started`, `prompt-submitted`, `state-changed`, `command-failed`, `settled`, `disappeared`, `timed-out`, and `recovery-started`. Each event stores only `sequence` plus `type` plus `target` plus optional bounded `code` plus optional bounded `detail` plus timestamp `at`; response text, export payloads, cursors, reasoning, transcripts, and scrollback are never fields.

Hard guardrails are enforced in code: no chain of thought, no transcripts, no scrollback (`SENSITIVE_CONTENT_EXCLUDED` on `transcript`, `scrollback`, or `chain of thought`), bounded size per field (target at most 64 characters, code at most 64, detail at most 512), bounded retention per log (default 100 events, configurable 1 through 1000, oldest dropped first with a reported `dropped` count), never read as results, and never a substitute for authoritative retrieval.

Failure taxonomy stays M1-authoritative; diagnostics only labels what the M1 loop already decided:

| Code | Meaning | Troubleshooting |
| --- | --- | --- |
| `AGENT_NOT_SETTLED` | `working` or `unknown` (including missing status); continue polling, bounded retries, `unknown` stays inconclusive and never complete | Keep polling `herdr agent get`; do not retrieve yet |
| `AGENT_BLOCKED` | `blocked`; inspect with `herdr agent get` plus `herdr agent read`, then decide with never blind input | Inspect live state, apply user safety constraints, never answer blind |
| `AGENT_ERROR` | Explicit `error` or `failed` status; report with preserved state, not retryable as working | Report the explicit error state with preserved state |
| `AGENT_NOT_FOUND` | Disappearance: `agent_not_found` on `get` or vanished from `herdr agent list` | Emit an explicit disappearance report with preserved state; redesign or re-contract, never treat as settled |
| `HERDR_UNAVAILABLE` | Start, prompt, `get`, or export command failure (for example connection refused) | Surface immediately with this distinct code; never decay to timeout |
| `WAIT_TIMEOUT_EXPIRED` | Safety timeout expiry from `waitTimeoutError`; the prompt-level final bound only | Report timeout with preserved state; earlier failures keep their own codes |

Diagnostic versus authoritative split:

- Diagnostics are troubleshooting hints only: `createDiagnosticsLog` plus `record` plus `list` never return response text and never decide settlement, retrieval, review, or integration.
- Authoritative results flow only through `herdr_agent_response`: call with the worker name, then follow each returned cursor until `complete` is true; continuation pages do not query Herdr again and stay pinned to session, message, digest, and offset.
- A missing or cleared diagnostics buffer never blocks progress: re-query `herdr agent get` plus `herdr_agent_response` as the source of truth; `unknown` stays inconclusive in both channels.
- Diagnostics never feed semantic decisions: populating, clearing, or dropping diagnostic events does not change `classifyAgentStatus`, response selection, pagination, cursors, or the retrieval matrix.

Timeout versus early failure troubleshooting lineage:

1. Poll `herdr agent get <name>` on the short interval; `working` means continue (`AGENT_NOT_SETTLED`).
2. A start or prompt command failure surfaces immediately as `HERDR_UNAVAILABLE` with its own detail; do not wait for the timeout.
3. Disappearance (`agent_not_found` or absent from `herdr agent list`) surfaces immediately as `AGENT_NOT_FOUND` with an explicit report.
4. `blocked` surfaces as `AGENT_BLOCKED` for inspect-then-decide; `error` or `failed` surfaces as `AGENT_ERROR` as an explicit report.
5. Only when none of the above settled the worker does the safety timeout expire as `WAIT_TIMEOUT_EXPIRED` via `waitTimeoutError`, preserving state as the final bound. Record `timed-out` only here; record `command-failed`, `disappeared`, or `settled` at their own steps so a timeout is never confused with an early failure.

File and line references:

- Events and guardrails: `src/diagnostics.js:9` (`DIAGNOSTIC_EVENT_TYPES`), `src/diagnostics.js:20` (`MAX_DIAGNOSTIC_EVENTS_DEFAULT`), `src/diagnostics.js:25` (`SENSITIVE_DIAGNOSTIC_PATTERN`), `src/diagnostics.js:79` (`createDiagnosticsLog`), `src/diagnostics.js:87` (`record`), `src/diagnostics.js:109` (`list`).
- Authoritative taxonomy and retrieval: `src/response.js:16` (`RESPONSE_MATRIX`), `src/response.js:40` (`classifyAgentStatus`), `src/response.js:59` (`waitTimeoutError`).
- Bounded wait loop wording: `src/prompts.js:28` (shepherd loop), `src/prompts.js:88` (governor loop), `src/prompts.js:121` (sheepdog loop).
- Already-permitted wait surfaces only: `src/agents.js:47` (`herdrInspection`).

## Installation

Install or update the plugin with the cross-platform npm CLI:

```bash
npx -y opencode-herdr-orchestration@latest install
npx -y opencode-herdr-orchestration@latest update
```

The installer:

- locates the global OpenCode config directory;
- installs an exact package version there;
- interactively asks which models the shepherd, sheepdog, flock worker, and shearer reviewer roles should use when run in a terminal;
- preserves existing JSONC comments, trailing commas, plugins, and tuple options;
- adds the stable file URL required by current OpenCode npm plugin loading;
- creates timestamped backups of changed config and npm manifest files;
- validates every agent role through a short-lived OpenCode debug process;
- never restarts or signals a running OpenCode process.

The shared Git push policy remains opt-in:

```bash
npx -y opencode-herdr-orchestration@latest install --with-hooks
```

Inspect or remove the installation:

```bash
npx -y opencode-herdr-orchestration@latest status
npx -y opencode-herdr-orchestration@latest configure-agents
npx -y opencode-herdr-orchestration@latest uninstall
npx -y opencode-herdr-orchestration@latest uninstall --with-hooks
```

After installation or update, quit and restart OpenCode intentionally when ready. Existing processes keep their already-loaded configuration.

`configure-agents` updates the same model choices after installation. Press Enter to keep the displayed value, or enter `-` to restore that role's package default. Model names must include their provider prefix, such as `anthropic/claude-sonnet-4-6`. The sheepdog, grazer, and sheep reasoning efforts accept the provider's variant names, such as `low`, `medium`, or `high`; leaving any unset uses the model's default reasoning behavior. Shepherd-phase agents always inherit the active model and its reasoning behavior, and shearer reasoning stays fixed at `low` and `medium`.

## Manual Installation

Add the published package to the global OpenCode configuration at `~/.config/opencode/opencode.json` or `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-herdr-orchestration"]
}
```

If `plugin` already contains entries, append `"opencode-herdr-orchestration"` instead of replacing them. OpenCode installs npm plugins automatically when it starts.

Install the package into that config directory so the stable file URL can resolve it:

```bash
cd ~/.config/opencode
npm install --save-exact opencode-herdr-orchestration@latest
```

Current OpenCode releases may record but not execute npm plugins referenced only by package name. If that occurs, use the installed entry path in the plugin tuple instead:

```jsonc
{
  "plugin": [
    "file:///ABSOLUTE/PATH/TO/.config/opencode/node_modules/opencode-herdr-orchestration/src/plugin.js"
  ]
}
```

Optionally install the shared Git push policy for all current and future repositories:

```bash
npx opencode-herdr-orchestration install-hooks
```

Then quit and restart OpenCode intentionally. Agent and plugin configuration is loaded only at process startup; installing the package does not restart or modify running OpenCode sessions.

Confirm the installed agents:

```bash
opencode agent list
```

The expected package agents are `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, and `shearer-medium`.

## Breaking migration: remove stale agent files

**Before updating to the current package, remove stale standalone agent files from the previous architecture.** Agent definitions are merged by agent name, so a leftover local file with a colliding name silently overrides the corresponding package fields, including its prompt and permissions.

Archive or remove these standalone files after any existing OpenCode processes that depend on them have ended:

- `shepherd-plan.md`
- `shepherd-build.md`
- `sheep-plan.md`
- `sheep-build.md`
- `shearer-review-low.md`
- `shearer-review-medium.md`
- Older misspelled files such as `sheperd-plan.md` and `sheperd-build.md`, which load as additional legacy agents until removed.

Do not remove agent files merely to affect an already-running process. Complete or stop that process first, update the files, then start a new OpenCode process and verify the effective agent list with `opencode agent list`.

Local agent definitions with the same names are merged over plugin defaults. This permits deliberate user customization without losing unspecified plugin permissions or prompts — but only if the local file is intentionally maintained, not a stale leftover.

## Plugin configuration

During local development, reference the source directly in the global OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///C:/Dev/opencode-herdr-orchestration/src/index.js"
  ]
}
```

For the published package, use:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-herdr-orchestration"]
}
```

Plugin tuple options can override model defaults:

```jsonc
{
  "plugin": [
    [
      "opencode-herdr-orchestration",
      {
        "shepherdModel": "anthropic/claude-sonnet-4-6",
        "sheepdogModel": "litellm/glm-5.3-flash",
        "sheepdogVariant": "medium",
        "workerModel": "litellm/glm-5.3-flash",
        "grazerVariant": "low",
        "workerVariant": "medium",
        "reviewerModel": "litellm-responses/gpt-5.6-terra"
      }
    ]
  ]
}
```

The sheepdog has its own model and reasoning effort options, and grazer reasoning can be configured separately from sheep worker reasoning.

Machine-specific governance permissions and instructions can also be added declaratively without a local JavaScript wrapper:

```jsonc
{
  "plugin": [
    [
      "opencode-herdr-orchestration",
      {
        "shepherdPermissions": {
          "private_deployment_status": "allow"
        },
        "shepherdPromptAppend": "Use private deployment tools according to local policy."
      }
    ]
  ]
}
```

`shepherdPermissions` is merged over the planning `shepherd` agent's permissions. `shepherdPromptAppend` is appended as a separate final paragraph to the `shepherd` agent's prompt. Keep secrets out of plugin options because configuration may be displayed by diagnostics.

Sheepdog squad-local options use the same scoped pattern and affect only `sheepdog`:

```jsonc
{
  "plugin": [
    [
      "opencode-herdr-orchestration",
      {
        "sheepdogPermissions": {
          "private_squad_status": "allow"
        },
        "sheepdogPromptAppend": "Use private squad tools according to local policy."
      }
    ]
  ]
}
```

`sheepdogPermissions` is merged over the `sheepdog` agent's permissions only; it never touches `shepherd`, `shepherd-governor`, or leaves, so local config cannot silently broaden another role or replace its lifecycle allows. `sheepdogPromptAppend` is appended as a separate final paragraph to the `sheepdog` prompt. Sheepdog lifecycle stays evaluation-effective by explicit ordering: `*` deny first, `herdr agent prompt` plus `wait` plus `get` plus `read` allows in the middle, Git lifecycle allows plus Ctrl-C-only `send-keys` plus delivery denials next, separator denies (`*;*`, `*&&*`, `*||*`, `*|*`, `*>*`, `*<*`) global last. A prompt whose task text carries raw separators fails closed to deny even inside quotes; construct task text content-safe by quoting identifiers and splitting or rephrasing delivery instead of embedding separators.

Machine- or organization-specific MCP tools, deployment rules, and private service instructions should stay in a local governance-agent override rather than this public package. Add only the private permissions and prompt additions required by your environment; unspecified package defaults remain intact through deep merging.

OpenCode loads plugins and agent definitions at startup. Restart OpenCode when intentionally enabling or updating the plugin. The installer never stops or restarts an OpenCode process.

### Project permission skill (15-M1)

Project agent permissions live in `opencode.json` in the project root (an existing `opencode.jsonc` beside it loads as a separate local layer; helpers edit only the found file and preserve the other). Configs merge per-key with project agent rules taking precedence: later overrides earlier only for conflicting keys while unrelated keys plus comments plus plugins plus tuples stay preserved. Helpers target `agent.<name>.permission` blocks as text for all seven roles `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, and `shearer-medium` with set plus delete semantics (`undefined` deletes) and idempotent reapply via `parse` plus `modify` plus `applyEdits` with timestamped backups; confinement stays fail-closed inside the project root and refuses global plus outside plus nested paths. Supervision stays unchanged: the governor still spawns only `grazer` and `sheepdog`, `sheepdog` remains the sole supervisor of leaves, leaves gain no new commands, and spawn plus response plus state matrices stay intact.

The governor skill is prompt-embedded with no native `SKILL.md`. Only the human Developer invokes it by writing exactly "govern project permissions" quoted back in the governor prompt; denials never invoke this skill and a denied operation never bypasses through it but fails closed with `STOP` plus preserved state. Preserve unrelated work, inspect every project config change with `git diff` before accepting it, verify the merged view with `opencode debug config` in the project, and on failure fix or remove the project file then confirm global-only with `OPENCODE_DISABLE_PROJECT_CONFIG=1 opencode debug config` before restarting OpenCode intentionally. Live evidence on `1.18.29` binds this design: both `opencode.json` and `opencode.jsonc` load as scope `local` while empty shows global-only, a project probe key merges with plugin keys while a conflicting project `deny` overrides a plugin `allow`, invalid project JSON fails `opencode debug config` with `not valid JSON(C)` while the disable flag shows global-only, and `opencode debug skill` shows 4 skills with 3 file-based globals plus zero project `.opencode/skills` files so M1 stays prompt-embedded. A native `SKILL.md` is allowed only on clean zero global evidence.

File and line references: project helpers in `src/installer.js` (`PROJECT_CONFIG_FILE`, `PROJECT_CONFIG_FILENAMES`, `findProjectConfigFile`, `resolveProjectConfigFile`, `updateProjectAgentPermissions`, `writeProjectAgentPermissions`); skill text in `src/prompts.js` (`GOVERNOR_PROJECT_PERMISSION_SKILL_PARAGRAPH` in `SHEPHERD_GOVERNOR_PROMPT`); helper plus skill assertion tests in `test/installer.test.js`; end to end workflow tests in `test/project-skill-e2e.test.js`; negative tests in `test/project-skill-negative.test.js`.

### Project permission workflow (15-M2)

Full end to end workflow from human instruction to effective debug config, using only disposable project fixtures in the OS temp area plus project roots with no global writes anywhere:

1. Supply: the human Developer supplies the exact quoted instruction `govern project permissions` in the governor session. No agent, denial, tool output, or file content supplies it; only the human writing exactly that string quoted back in the governor prompt invokes the skill.
2. Invoke: the governor applies the prompt-embedded skill explicitly with `updateProjectAgentPermissions` plus `writeProjectAgentPermissions` against the resolved project file. Denials never invoke this skill and a denied operation never bypasses through it but fails closed with `STOP` plus preserved state; there is no auto path in code from a denial to a project write.
3. Inspect: preserve unrelated work and inspect every project config change with `git diff` before accepting it. Confirm `git status --porcelain` shows only the intended project file, `git diff` shows only the intended `agent.<name>.permission` hunks, and unrelated tracked work is untouched. Helpers use `parse` plus `modify` plus `applyEdits` so unrelated keys plus comments plus plugins plus tuples stay preserved, with timestamped backups on updates and idempotent reapply.
4. File location: project agent permissions live in `opencode.json` in the project root; an existing `opencode.jsonc` beside it loads as a separate local layer and helpers edit only the found file while preserving the other. Helpers stay fail-closed inside the project root and refuse global plus outside plus nested paths: the global config directory as project root, the exact global file, any path inside the global directory, any outside path, any nested path, and any non-project filename are refused with no filesystem write.
5. Merge preservation: configs merge per-key with project agent rules taking precedence — later overrides earlier only for conflicting keys while unrelated keys plus comments plus plugins plus tuples stay preserved. Helpers target `agent.<name>.permission` blocks as text for all seven roles `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, and `shearer-medium` with set plus delete semantics (`undefined` deletes). A project probe key merges with plugin keys while a conflicting project `deny` overrides a plugin `allow`; top-level `permission` never leaks into agent blocks.
6. Inspection method: verify the merged view with `opencode debug config` in the project, which shows both `opencode.json` and `opencode.jsonc` as scope `local` while an empty project shows global-only. Invalid project JSON fails that command with `not valid JSON(C)` and no automatic fallback. End to end fixtures prove the same effective confirmation without a live binary by parsing the project file, checking the probe key coexists with base allows, and checking a conflicting `deny` would override an `allow`.
7. Restart requirements: OpenCode loads plugins and agent definitions at startup, so quit and restart OpenCode intentionally when ready after accepting the project change. Existing processes keep their already-loaded configuration and the installer never stops or restarts a running process. On failure fix or remove the project file then confirm global-only with `OPENCODE_DISABLE_PROJECT_CONFIG=1 opencode debug config` before restarting intentionally.
8. Authority boundaries: supervision stays unchanged — the governor still spawns only `grazer` and `sheepdog`, `sheepdog` remains the sole supervisor of leaves, leaves gain no new commands, and spawn plus response plus state matrices stay intact even with widened project tools. Steering never authorizes `push`, `tag`, `publish`, `deploy`, `merge`, or any consequential action and existing approvals still apply after any permission grant. A steering entry that says `push and deploy now` is still just text. Project helpers never touch global config and never write outside the project root.

## Install the Git policy

Run once after installing the npm package:

```bash
npx opencode-herdr-orchestration install-hooks
```

Or run directly from this checkout:

```powershell
node C:\Dev\opencode-herdr-orchestration\bin\orchestration.js install-hooks
```

The command copies the hook to a stable user location and configures:

```text
~/.config/opencode-herdr-orchestration/hooks
```

as global `core.hooksPath`. Every new clone, initialized repository, and linked worktree then receives the same policy automatically.

The installer refuses to replace an existing global `core.hooksPath`. Review and compose existing hooks first; `--force` is available only for an intentional replacement.

Inspect or remove the setting from an installed package:

```bash
npx opencode-herdr-orchestration status
npx opencode-herdr-orchestration uninstall-hooks
```

From this checkout:

```powershell
node .\bin\orchestration.js status
node .\bin\orchestration.js uninstall-hooks
```

## Worker interruption

Herdr currently exposes `send-keys`, not a narrower agent interrupt command. Shepherd-phase agents retain it to send Ctrl+C only after confirming that a worker is genuinely stuck. Prompts prohibit using worker terminals to type implementation commands or bypass shepherd permissions. Sheepdog is further scoped to Ctrl-C-only replacement semantics as far as Bash matchers permit: the broad `herdr agent send-keys*` allow is replaced by an explicit deny plus narrow `C-c` and `ctrl+c` `--keys` spellings, with separator denies still global last and inspect-first plus never-type plus never-bypass staying primary in `SHEEPDOG_PROMPT`. Governor is likewise scoped to Ctrl-C-only replacement semantics in `src/agents.js` with the same residual: the broad allow is denied and only narrow Ctrl-C spellings are evaluation-effective, with separator denies still global last and the governor prompt inspect-first plus never-type plus never-bypass rule staying primary.

This restriction is not hard-enforced by Herdr. Matchers are string globs and cannot prove semantic intent or enumerate every Herdr spelling, so a crafted `send-keys` that matches a narrow Ctrl-C glob but carries extra intent remains possible; a native `herdr agent interrupt <target>` command would close that capability gap.

## Developer steering

Developer steering is a trusted-Developer queue scoped per Plan ID target under `<git-common-dir>/flocky/steering/<planId>/`. There is exactly one submission tool, `herdr_steering_submit`, registered through the existing plugin mechanism. The submission allowlist holds only the explicit non-flock `developer` context; `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, `shearer-medium`, `unknown`, `ambiguous`, `none`, and unset contexts are denied fail-closed with no filesystem write. Developer is never inferred from session mode, directory, environment text, or prompt content. Static per-agent permissions deny the tool for all seven orchestration roles as defense in depth; the runtime `context.agent` check stays authoritative over static overrides.

### Steering UX through the existing integration

There is no `herdr steer` command and no package CLI steering command. The Developer submits only through the `herdr_steering_submit` plugin tool in a Developer context:

```json
{
  "planId": "topic-20260901-01",
  "content": "Hold scope; keep the migration local."
}
```

`content` is required and bounded to at most 8192 UTF-8 bytes; `planId`, when given, must be 1-64 characters of letters, digits, dot, underscore, or hyphen and must not start with a dot. The request accepts only `content` plus an optional explicit `planId`; any other field fails with `INVALID_REQUEST` and writes nothing. The Shepherd phases consume through the existing ownership-gated tools only: `herdr_steering_check` shows unread counts without loading bodies, `herdr_steering_read` returns ordered exact unread with no mutation, and `herdr_steering_consume` advances only after the authoritative owner recorded a sync disposition for the claimed sync point. `check` and `read` never mutate; `read` before `consume` leaves entries unread across process restarts and service instances. `consume` is idempotent: repeating the same ids with the same recorded disposition returns the same checkpoint without advancing differently. Steering entries are immutable per target with a service-assigned sequence starting at 1, an opaque id shaped like `st_<16 hex>`, an ISO timestamp, trusted provenance, target identity, bounded content, and schema version 1, stored as `<git-common-dir>/flocky/steering/<planId>/entries/<10-digit-sequence>-<id>.json`. Per-Plan-ID ordering isolates unrelated plans: sequence 1 in one plan is independent of sequence 1 in another. Sheepdog and every leaf never see raw steering; they are denied `herdr_steering_check`, `herdr_steering_read`, and `herdr_steering_consume` in `src/agents.js` and in the runtime allowlist in `src/index.js`, not only in prompts, and receive only normal corrective instructions from the Shepherd.

### Target ambiguity behavior

Target resolution uses the explicit `planId` or infers only when exactly one active steering target exists, else it fails closed with `AMBIGUOUS_TARGET` and creates no repository-wide steering. Zero targets with no explicit `planId` reports that no target was given and no active target exists; two or more targets with no explicit `planId` reports how many exist and requires an explicit `planId`. Both cases set `retryable: false` and perform no filesystem write. Inference scans only immediate child directories of `<git-common-dir>/flocky/steering/` whose names satisfy the Plan ID pattern and are directories; files, hidden names, traversal names, and non-directories are ignored. When a lifecycle record exists for the target, inference alone is insufficient: the caller must also prove authoritative phase plus session plus generation, otherwise the call fails with `NOT AUTHORITATIVE PHASE` and loads no bodies. Gated `check`, `read`, and `consume` calls require an explicit `planId` together with `phase`, `session`, and `generation`; a partial proof fails with `INVALID_REQUEST`. Operator rule: always pass an explicit `planId` from the plan header; omit it only for a single-plan repository as a convenience.

Queue mechanics: `check` reports `total`, `unread`, `nextSequence`, and `highestContiguous` without loading bodies; `read` returns ordered exact unread entries plus the checkpoint with no mutation; `consume` takes explicit `ids` (1-1000 per call) and advances only after durable checkpoint disposition. The checkpoint holds the highest contiguous consumed sequence plus the sorted consumed ids, so non-contiguous consumes leave the contiguous pointer at the gap until the gap is filled. Mutations use a scoped per-target lock via exclusive create (`queue.lock`, 30 second stale takeover, 200 retries every 10 ms) plus a journal via atomic rename (`queue.journal`) with stale takeover and replay, so interruption is recoverable as described in Recovery.

### Provenance honesty and limits (integration-asserted, not authenticated)

The recorded `developer` submitter is integration-asserted by the OpenCode plugin runtime (`context.agent === "developer"`), never an authenticated human. The entry stores:

```json
{
  "submitter": "developer",
  "integration": "integration-asserted Developer context; not an authenticated human"
}
```

Any session that can present as `developer` — including a custom-configured `developer` agent — can submit. Flock roles cannot present as Developer: `developer` is not a registered orchestration agent, no spawn matrix entry creates it, static per-agent permissions deny `herdr_steering_submit` for all seven orchestration roles, and the runtime allowlist holds only `developer`. The runtime check stays authoritative over static overrides: even a local config that flips a flock role to `allow` still fails with `UNAUTHORIZED_AGENT` and writes nothing. Developer is mapped to an explicit non-flock `SHEPHERD_MODE` value `developer`, distinct from `shepherd`, `governor`, `sheepdog`, `grazer`, `sheep`, `shearer`, and `none`. Keep remote authorization and human review as the authoritative controls for anything consequential. There is no `herdr steer` command and no package CLI steering command; `bin/orchestration.js` and `package.json` expose only `opencode-herdr-orchestration` with `install`, `update`, `configure-agents`, `status`, `uninstall`, `install-hooks`, and `uninstall-hooks`.

## Shepherd ownership and lifecycle synchronization

Validated target lifecycle records live per active Plan ID under `<git-common-dir>/flocky/ownership/<planId>/record.json` with bounded fields for plan ID plus phase (`planning`, `governance`) plus authoritative session plus generation plus milestone plus lifecycle state plus current objective plus current action plus active sheepdog target plus relevant revision plus pending consequential action plus timestamp, using closed vocabularies for phase, lifecycle state, sync point, disposition, and snapshot stage. Text fields store only bounded semantic summaries; reasoning transcripts and scrollback are rejected with `SENSITIVE_CONTENT_EXCLUDED`.

Planning-to-governance handoff uses session plus generation fencing under a per-target lock: the first claim must use generation 1 and every handoff must increase generation, so both phases cannot race on the same generation. Once a record exists, only the recorded owner phase plus session plus generation may use the raw steering `check`, `read`, and `consume` operations and the owner lifecycle tools (`herdr_ownership_claim`, `herdr_ownership_read`, `herdr_ownership_sync`, `herdr_ownership_snapshot`, `herdr_ownership_correct`); any other caller receives `NOT AUTHORITATIVE PHASE` with no bodies loaded. Raw steering tools are shepherd-only in code: `sheepdog`, `grazer`, `sheep`, `shearer-low`, and `shearer-medium` are explicitly denied in `src/agents.js` and in the runtime allowlist in `src/index.js`, not only in prompts.

Semantic synchronization covers both shepherd phases at eight mandatory checkpoints (`planning-start`, `pre-plan`, `pre-assignment`, `milestone-executing`, `result-received`, `continue`, `finalize`, `consequential-preparation`): the owner records disposition (`integrated`, `corrected`, `escalated`, `deferred`) before consume, and consume is idempotent. Snapshots cover `planning`, `executing`, `result-evaluation`, and `consequential-preparation`; pending consequential action must already be recorded before the consequential-preparation snapshot and its mandatory check. Corrections route from shepherd to sheepdog as normal corrective instructions, never raw records (`RAW_RECORD_REJECTED` on dumps); steering never authorizes `push`, `tag`, `publish`, `deploy`, `merge`, or any consequential action, and existing approvals still apply.

### One Shepherd, two phases

There is one Shepherd with two technical phases, each a registered agent. `shepherd` is the planning phase: it researches through read-only `grazer` workers and presents implementation-ready plans, and never implements. `shepherd-governor` is the governance phase: selecting it approves the latest presented plan, and it then contracts bounded work through `sheepdog` squads, judges semantics, and owns everything remote. Authority flows down only; milestones never imply acknowledgement and acknowledgement never auto-advances a milestone. The lifecycle record enforces this: `phase` is `planning` or `governance`, `session` is 1-128 characters of letters, digits, colon, underscore, or hyphen, and `generation` is a safe integer starting at 1. `herdr_ownership_claim` creates the record on generation 1 and hands off only on a strictly larger generation under a per-target lock (`queue.lock`, 30 second stale takeover); equal or smaller generations fail with `STALE_GENERATION` so both phases cannot race on the same generation. `herdr_ownership_read` requires the recorded phase plus session; a mismatch fails with `NOT AUTHORITATIVE PHASE`. Gated steering calls map a stale generation to `NOT AUTHORITATIVE PHASE` as well, so a handed-off owner immediately loses authority. Lifecycle state is one of `planning`, `executing`, `result-evaluation`, `consequential-preparation`, or `finalized`. Submitting during a milestone while `activeSheepdogTarget` is set is allowed; consumption waits until sheepdog yields (ownership clears the target on a newer generation) and the owner records the matching sync disposition first, otherwise `consume` fails with `SYNC_REQUIRED`.

### Separate consequential authorization

Steering never authorizes consequential actions. Every `consume`, `sync`, `snapshot`, and `correct` response carries:

```json
{
  "push": false,
  "tag": false,
  "publish": false,
  "deploy": false,
  "merge": false,
  "anyConsequential": false,
  "approvalsStillRequired": true
}
```

`consequentialPolicy` additionally reports `deniedActions: ["push", "tag", "publish", "deploy", "merge"]` with the note that existing approvals are still required. A steering entry that says "push and deploy now" is still just text: `consume` returns the denial alongside the checkpoint and the Shepherd must still obtain the normal plan acknowledgement, review verdicts, deterministic checks, and delivery approvals before acting. `herdr_ownership_sync` and `herdr_ownership_snapshot` for `consequential-preparation` require a non-empty `pendingConsequentialAction` already recorded in the lifecycle record, otherwise they fail with `PENDING_CONSEQUENTIAL_REQUIRED`; the pending text is only a bounded semantic summary of what will be prepared, never an authorization. `herdr_ownership_correct` routes only normal corrective instructions to `sheepdog` (`target: "sheepdog"`, `channel: "normal-corrective-instructions"`); JSON dumps carrying `sequence` plus `st_<16 hex>`, `consumedIds`, or `checkpoint`/`highestContiguous` shapes fail with `RAW_RECORD_REJECTED`.

## Flocky layout

All durable state lives under the repository's shared Git common directory (`git rev-parse --git-common-dir`, canonicalized through the native `realpath` binding so Windows 8.3 aliases and linked worktrees resolve to one identity). The service invokes only read-only `git rev-parse --git-common-dir` and `git rev-parse --show-toplevel`; it never writes arbitrary Git metadata.

```text
<git-common-dir>/flocky/
  plans/<planId>.md
  executions/<planId>.md
  steering/<planId>/
    entries/<10-digit-sequence>-<steering-id>.json
    checkpoint.json
    queue.lock
    queue.journal
  ownership/<planId>/
    record.json
    sync.json
    snapshots/<stage>.json
    queue.lock
```

Plan IDs are single path segments: 1-64 characters of letters, digits, dot, underscore, or hyphen, never starting with a dot. Markdown bodies are capped at 1 MiB; metadata values at 512 characters; steering content at 8192 UTF-8 bytes. Every worker worktree sheepdog creates — including worktrees created from other worktrees — is a peer sharing the same common directory, never a nested checkout, so a plan written in one worktree governs workers in all of them and survives session ends, process restarts, and machine reboots. Separate clones never share state: a copied artifact fails with `IDENTITY_MISMATCH` because the recorded `identity` differs from the current common directory. The recorded worktree top level is provenance only (`recordedToplevel` versus `currentToplevel` plus `toplevelMatches`); linked worktrees with different top levels read the same artifacts. The previous `<git-common-dir>/herdr` root is a compatibility source only: it is reconciled into `flocky` before every plan or execution operation, never auto-deleted, and never a second canonical authority. Retired coordination files `<git-common-dir>/flocky/.migration-lock` and `.migration-journal` are removed best-effort and never block reconciliation. Promotion staging temps (`<target>.<pid>.<hex>.migrating` plus atomic-write `<pid>.<hex>.tmp` files) and per-artifact repair guards (`<target>.repairing`) are service-owned and never user artifacts.

## Upgrade

Update through the cross-platform CLI; never hand-edit the global config while an OpenCode process that depends on it is running:

```bash
npx -y opencode-herdr-orchestration@latest update
npx -y opencode-herdr-orchestration@latest configure-agents
npx -y opencode-herdr-orchestration@latest status
```

The updater locates the global OpenCode config directory, installs the exact version, preserves JSONC comments and tuple options, creates timestamped backups of changed config and npm manifest files, validates every agent role through a short-lived OpenCode debug process, and never restarts a running OpenCode process. On validation failure it restores the previous config and reports the error. After installation quit and restart OpenCode intentionally; agent and plugin configuration loads only at startup. Before updating to the current package, archive or remove stale standalone agent files after dependent processes have ended (`shepherd-plan.md`, `shepherd-build.md`, `sheep-plan.md`, `sheep-build.md`, `shearer-review-low.md`, `shearer-review-medium.md`, plus misspelled `sheperd-plan.md` and `sheperd-build.md`); a leftover file with a colliding name silently overrides package fields. The installer reports package-owned deletions versus unowned or modified files that require manual review, and `status` reports installed versus latest versions, configured agents, and obsolete files. The shared Git push policy stays opt-in via `install --with-hooks` or `install-hooks`, which refuses to replace an existing global `core.hooksPath` without `--force`. Add repository-specific protected branches with `git config --add orchestration.protectedBranch <name>`; `main` and `master` are always protected in governance mode.

## Troubleshooting

Live-verified on `herdr 0.8.2` plus `opencode 1.18.29` plus package `0.2.1` with `stable` Herdr channel and `opencode: current (v10)` integration. Every command below was executed before printing; live evidence wins over memory. For full procedures see [Installation](#installation), [Manual Installation](#manual-installation), [Upgrade](#upgrade), and [Recovery](#recovery) instead of duplicating them here.

### Missing Herdr OpenCode integration

**Symptom:** `opencode agent list` misses one or more of `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, `shearer-medium`, or `herdr integration status` shows `opencode: not installed` instead of the healthy `opencode: current (v10)`.

**Cause:** The Herdr OpenCode integration is not installed, or OpenCode started before the plugin was configured. Agent and plugin configuration loads only at startup and the installer never restarts a running process (see [Upgrade](#upgrade)).

**Check:** Run the read-only checks and compare with the healthy outputs observed live. `herdr integration status` shows `opencode: current (v10)`. `opencode agent list` lists all seven roles with `(primary)`. `opencode debug agent shepherd` returns JSON with `"name": "shepherd"`. `node bin/orchestration.js status` reports all seven `detectedAgents` with `"agentsReady": true` plus matching `installedVersion` and `latestVersion` of `0.2.1` with `"updateAvailable": false`. On Windows PowerShell the `herdr` launcher resolves per `(Get-Command herdr).Source` to the Herdr `bin` exe verified as `herdr 0.8.2` via `herdr --version`. `herdr --help` lists `herdr integration <subcommand>` and `herdr integration install --help` lists `opencode` as a valid target.

**Fix:** Follow [Installation](#installation) or [Upgrade](#upgrade) for the install plus update path, then quit and restart OpenCode intentionally when ready. Existing processes keep their already-loaded configuration. Do not hand-edit the global config while a dependent OpenCode process is running.

**Verify:** Repeat the check commands until `herdr integration status` shows `opencode: current (v10)`, `opencode agent list` shows all seven roles, `opencode debug agent shepherd` resolves `shepherd`, and `node bin/orchestration.js status` shows `"agentsReady": true`. If the integration stays missing, re-read [Installation](#installation) plus [Upgrade](#upgrade) instead of inventing new install spellings.

### Windows exe versus shim launcher resolution

**Symptom:** `opencode --version` reports an unexpected version, a process spawn fails with `%1 is not a valid Win32 application`, or `node bin/orchestration.js status` misses agents even though the config looks correct.

**Cause:** On Windows PowerShell `opencode` may resolve to the direct exe (`node_modules/opencode-ai/bin/opencode.exe`) or to a shim (`opencode.cmd`, `opencode.ps1`, `opencode.exe` in the npm prefix) depending on `PATH` order. `PATH` here means the session `PATH` inspected read-only with `$env:PATH`. File-version text is not authoritative next to CLI `opencode --version` output `1.18.29`. Herdr panes inherit the Herdr server environment, not the current session `PATH`. A global `opencode upgrade` recreates the npm shims, so a previously durable order can flap back to shim-first with a bumped `opencode --version` versus `npm view opencode-ai version`.

**Check:** Inspect the resolver without changing it. `(Get-Command opencode).Source` shows the winning launcher. `(Get-Command opencode -All).Source` lists every candidate in order and reveals a reappearing shim after a global update. `(Get-Command herdr).Source` plus `(Get-Command herdr -All).Source` confirms Herdr resolves to a single `bin` exe with no shim confusion. Compare `opencode --version` against the full-path exe and shim forms; healthy hosts report the same `1.18.29` from each, while a bumped `opencode --version` against `npm view opencode-ai version` signals a recent global update. Confirm the process-spawn path with `Start-Process` using `-FilePath` from the resolved launcher plus `-ArgumentList --version -NoNewWindow -Wait`; live the extensionless shim fails with `%1 is not a valid Win32 application` while the direct exe reports `1.18.29`. Inspect order read-only with `$env:PATH`. Confirm the server split with `herdr status` showing `status: running` for `server` separate from client. This package never overwrites the global environment. Config resolution only reads the environment in `src/installer.js:40` (`configDirectory`) and validation runs isolated with `OPENCODE_DISABLE_PROJECT_CONFIG` in `src/installer.js:529` (`validateOpenCode`), with status reporting in `src/installer.js:552` (`status`). Autoupdate context is `npm view opencode-herdr-orchestration version` reporting `0.2.1` matching `node bin/orchestration.js status` plus `herdr channel show` reporting `stable` plus `herdr update --help` describing the handoff option plus `opencode upgrade --help` listing upgrade targets and methods.

**Fix:** For current-session relief use the winning full exe path directly. For a durable fix apply a persistent user-chosen `PATH` reorder that places the direct exe directory before the npm shim directory, then restart Herdr plus the terminal plus OpenCode intentionally when ready, then follow [Upgrade](#upgrade) for the package update path. Session-local changes alone never fix Herdr spawns because panes inherit the server environment. This package never reorders global state automatically and never sets global environment values automatically; the persistent reorder is an operator-chosen Windows user environment change, not a package write.

**Verify:** Repeat `opencode --version` through the resolved launcher until it reports `1.18.29` with exe and shim forms agreeing, repeat the `Start-Process` probe until the direct exe reports `1.18.29` without `%1 is not a valid Win32 application`, re-inspect `(Get-Command opencode -All).Source` for a reappearing shim plus `opencode --version` versus `npm view opencode-ai version` for a bumped version after any global `opencode upgrade`, confirm `opencode debug agent shepherd` returns `"name": "shepherd"`, and confirm `node bin/orchestration.js status` shows `"agentsReady": true`. A launcher problem shows a `Source` mismatch, `%1 is not a valid Win32 application`, or stale version while a permission problem shows the correct `Source` plus `opencode --version` `1.18.29` but `status` still reports missing agents or `"agentsReady": false`, which routes to [Installation](#installation) plus [Upgrade](#upgrade) plus [Recovery](#recovery) instead of launcher reordering.

## Recovery

All mutations are atomic and replayable; interruption leaves at most inert temps or a journal that the next call replays idempotently. Operator rule: retry `STEERING_BUSY` and `OWNERSHIP_BUSY` (both `retryable: true`); never hand-delete a live lock, journal, checkpoint, or guard.

- Steering submit: the journal (`queue.journal` via atomic rename) is written before the immutable entry install (exclusive create `wx`), then cleared. A crash leaves an inert temp, a journal that replays the submit idempotently, or a durable entry. A torn journal (invalid JSON) is discarded and the submitter retries with a new id; a valid journal whose entry already exists reports `submit-already-durable`; otherwise it is replayed. A stale per-target lock (older than 30 seconds) is taken over by modification time; a live lock waits up to 200 retries every 10 ms then fails with `STEERING_BUSY`.
- Steering consume: the journal records the merged consumed ids before the checkpoint (`checkpoint.json` via atomic rename) advances, then is cleared. A crash replays the merged checkpoint idempotently; repeating the same ids returns the same `highestContiguous` plus sorted `consumedIds`. `read` before `consume` never mutates, so a failure or restart between them leaves entries unread for any fresh service instance in any linked worktree.
- Ownership: `record.json`, `sync.json`, and `snapshots/<stage>.json` are written via temp plus rename under the per-target `queue.lock` with the same 30 second stale takeover. Concurrent planning and governance contenders elect exactly one winner; losers fail with `STALE_GENERATION` and retry on the next generation.
- Migration: an interrupted promotion leaves at most an inert uniquely-named staging temp. Later calls sweep only stale temps (older than 30 seconds), never a live contender's fresh temp, and revalidate the legacy source before completing the install idempotently. A corrupt canonical copy is repaired only by the holder of the per-artifact `.repairing` guard; a stale guard is taken over by modification time while a live guard makes contenders fail closed with `MIGRATION_CONFLICT` instead of unlinking a concurrent winner.

## Legacy conflict handling

Reconciliation runs before every plan or execution operation and fails closed with structured `MIGRATION_CONFLICT` (`retryable: false`, with `conflicts` listing `artifactType`, `planId`, `reason`, `detail`, `legacyPath`, and `canonicalPath`); no artifact is selected or replaced on conflict. Both sides are preserved for manual review.

- `DIVERGENT_BYTES`: legacy and canonical copies are both valid but differ, or two contenders promoted different bytes and the loser byte-compared instead of overwriting. This also surfaces an active legacy write after a migration instead of last-writer-wins.
- `CORRUPT_LEGACY_ARTIFACT`, `LEGACY_SCHEMA_MISMATCH`, `LEGACY_ARTIFACT_TYPE_MISMATCH`, `LEGACY_PLAN_ID_MISMATCH`, `LEGACY_IDENTITY_MISMATCH`, `LEGACY_INVALID_METADATA`, `LEGACY_INVALID_MARKDOWN`: the legacy source failed the same validation a canonical write requires (schema 1, matching type and plan ID, current identity, valid `toplevel` plus timestamps, non-empty Markdown within 1 MiB). Nothing is promoted.
- `INVALID_PLAN_ID`: the legacy file name is not a valid Plan ID.
- `CONCURRENT_REPAIR`: another contender holds a live repair guard for a corrupt canonical target.

Identical bytes are accepted untouched; disjoint Plan IDs migrate independently without dropping either; valid legacy-only artifacts (including preserved IDs such as `developer-steering-flocky-state-20260901-01`) are staged from freshly validated bytes and installed through the atomic exclusive create that is the single linearization point. To resolve: inspect the named `legacyPath` and `canonicalPath`, decide which whole bytes are authoritative, make the copies byte-identical or remove the stale side only after review, then retry. The legacy root is never auto-deleted.

## Privacy boundary

Only bounded semantic summaries are stored; reasoning transcripts and terminal scrollback are never stored. Any lifecycle, sync, snapshot, or correction text matching `transcript` or `scrollback` (case-insensitive) fails with `SENSITIVE_CONTENT_EXCLUDED` and writes nothing. Closed vocabularies are the only accepted values for owner phase, lifecycle state, sync point, disposition, and snapshot stage; unknown values fail without creating new targets. Field caps are enforced: milestone at most 256 characters, objective and action at most 2048 each, sheepdog target and revision at most 128 each, pending consequential action at most 1024, correction at most 2048, note at most 2048, steering content at most 8192 UTF-8 bytes, Markdown bodies at most 1 MiB, metadata values at most 512 characters. Shepherd-phase agents govern by contracts and results, not by reading worker reasoning: `herdr_agent_response` returns only the latest completed final assistant message after the latest user prompt, excluding intermediate tool-call steps, errors, ignored text, reasoning, and terminal rendering, with UTF-8-safe pagination, HMAC-signed opaque cursors from a random per-plugin-process secret that expire after six hours and do not survive a plugin restart, and pinned session, message, digest, and offset continuations. Shearers receive only fresh bounded context (goal, plan, contract, base and implementation commits, diff, verification results), never the worker conversation. `SHEPHERD_MODE` is injected per OpenCode session and dies with the session; response cursors likewise do not survive a restart. Machine-specific governance permissions and private service instructions belong in a local agent override or `shepherdPermissions` plus `shepherdPromptAppend`, never in this public package; keep secrets out of plugin options because diagnostics may display configuration.

## Development

```bash
npm run check
npm test
```

Tests cover topology, model variants, permissions, override merging, session mode isolation, response selection, signed cursors, UTF-8 pagination, concurrent response reads, tool authorization, orchestration state storage and access, Developer steering submission allowlists and denials, append-only ordering, concurrent submissions, unread detection, read-without-consume, restart recovery, idempotent consume, Plan ID isolation, lock and journal recovery, permission parity, absence of steering CLIs, shepherd ownership lifecycle validation, session plus generation fencing, non-owner denial, both-phase race fencing, submission during milestone with consumption after sheepdog yields, each mandatory sync point with disposition before consume, snapshots with pending consequential gating, correction routing with raw-record rejection, no consequential authorization, worker raw-access denial, sensitive-data exclusion, M2 regression, M4 regression across a real linked worktree common directory plus migration across service instances and processes plus full end to end M1 through M3 submit plus ownership plus sync plus consume plus fail closed conflicts, project permission skill disposable-repo end to end from human instruction to skill application to git diff to debug config plus negative global refusal plus denial plus consequential plus flock preservation with widened project tools, and Git hook behavior on protected, worker, review, governance, and planning pushes.

## Releases

CI runs syntax checks, tests, and an npm package dry run on every branch push and pull request.

Releases are triggered only by tags shaped like `vMAJOR.MINOR.PATCH`. The release workflow verifies that the strict semantic version in the tag exactly matches `package.json`, reruns all checks, publishes the public npm package with provenance, and creates a GitHub release with generated notes.

The release job uses the protected GitHub environment named `npm`. Configure the repository Actions secret once before the first release:

```bash
gh secret set NPM_TOKEN --repo CodingJinxx/opencode-herdr-orchestration
```

Use an npm automation or granular access token authorized to publish `opencode-herdr-orchestration`. Then release by updating `package.json` and `package-lock.json`, committing, and pushing the matching tag:

```bash
npm version patch
git push origin master --follow-tags
```

The workflow intentionally fails before publishing when the tag and package version differ. It does not publish prerelease tags such as `v1.0.0-beta.1`.

For stronger release control, configure required reviewers on the `npm` environment and require the CI check on the protected default branch. The release is retry-safe: if npm already contains the same version from the same commit, it skips republishing and resumes GitHub release creation; a version published from another commit fails closed.

## Known limitations

- OpenCode command patterns cannot prove semantic Git intent; the hook adds checks but server-side protection is still required.
- `herdr agent send-keys` is broader than interrupt-only authority; sheepdog narrows it to Ctrl-C-only spellings as far as matchers permit, but matchers cannot prove intent and the prompt inspect-first rule stays primary.
- Global `core.hooksPath` is singular. Existing hook frameworks must be composed rather than overwritten.
- PR commands are narrowly available to the governance phase, but work only in GitHub repositories with an authenticated `gh` installation.
- Agent registration and environment hooks take effect only in newly started OpenCode processes.
- Worker session exports are capped at 64 MiB by default to bound host memory use. The response tool returns `SESSION_EXPORT_TOO_LARGE` rather than loading a larger session.
