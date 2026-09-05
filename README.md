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
- **Legacy `herdr` migration.** The previous `<git-common-dir>/herdr` root is retained as a compatibility source only: it is never auto-deleted and never acts as a second canonical authority. Before every plan or execution read/write the service reconciles the legacy root into the canonical Flocky root without any lock or shared journal — legacy-only artifacts are validated, staged to a unique temp, and installed through an atomic exclusive create (preserving valid legacy artifacts such as plan ID `developer-steering-flocky-state-20260901-01`); a lost install race re-reads the winner and byte-compares instead of overwriting, so concurrent contenders can never produce a divergent promotion; byte-identical copies are accepted; divergent valid copies fail closed with a structured `MIGRATION_CONFLICT` (no silent selection or replacement, so an active legacy write is surfaced instead of lost to last-writer-wins). An interrupted promotion leaves at most an inert staging temp, and any later call revalidates the legacy source and completes the install idempotently.
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

Machine- or organization-specific MCP tools, deployment rules, and private service instructions should stay in a local governance-agent override rather than this public package. Add only the private permissions and prompt additions required by your environment; unspecified package defaults remain intact through deep merging.

OpenCode loads plugins and agent definitions at startup. Restart OpenCode when intentionally enabling or updating the plugin. The installer never stops or restarts an OpenCode process.

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

Herdr currently exposes `send-keys`, not a narrower agent interrupt command. Shepherd-phase agents retain it to send Ctrl+C only after confirming that a worker is genuinely stuck. Prompts prohibit using worker terminals to type implementation commands or bypass shepherd permissions.

This restriction is not hard-enforced by Herdr. A native `herdr agent interrupt <target>` command would close that capability gap.

## Development

```bash
npm run check
npm test
```

Tests cover topology, model variants, permissions, override merging, session mode isolation, response selection, signed cursors, UTF-8 pagination, concurrent response reads, tool authorization, orchestration state storage and access, and Git hook behavior on protected, worker, review, governance, and planning pushes.

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
- `herdr agent send-keys` is broader than interrupt-only authority.
- Global `core.hooksPath` is singular. Existing hook frameworks must be composed rather than overwritten.
- PR commands are narrowly available to the governance phase, but work only in GitHub repositories with an authenticated `gh` installation.
- Agent registration and environment hooks take effect only in newly started OpenCode processes.
- Worker session exports are capped at 64 MiB by default to bound host memory use. The response tool returns `SESSION_EXPORT_TOO_LARGE` rather than loading a larger session.
