# opencode-herdr-orchestration

Capability-separated OpenCode agents for planning, implementation, independent review, and delivery through Herdr, organized as **Shepherd → Sheepdog → Flock**.

This package registers the agents, provides complete structured worker-response retrieval, injects session-specific orchestration mode into shell environments, and ships a reproducible Git `pre-push` policy for new and existing repositories.

Requires Node.js 20 or newer when running the package CLI or tests.

## Philosophy

There is exactly **one conceptual Shepherd per flock: the human operator**. The Shepherd owns intent, product judgment, risk tolerance, and every final approval. No agent replaces the Shepherd; agents only prepare decisions for them.

The **Sheepdog** is the technical layer that works on the Shepherd's behalf. Technically, the Sheepdog is two registered agents with distinct definitions:

- `shepherd-plan` — the **technical planning** authority. Researches the repository through read-only workers and presents implementation-ready plans. It never implements.
- `shepherd-build` — the **governance and delivery** authority. Approves plans by taking over the session, delegates bounded implementation and review work, runs deterministic validation, integrates results, and owns everything remote: pushes, merges, PRs, and delivery.

The **Flock** is the bounded workforce the Sheepdog herds:

- `sheep-plan` — read-only research workers.
- `sheep-build` — implementation workers that produce verified local commits.
- `shearer-review-low` / `shearer-review-medium` — independent read-only reviewers.

Three invariants govern the whole system:

1. **Authority flows down, never sideways or up.** Each role may mutate only what its authority permits. A worker cannot delegate; a reviewer cannot mutate; a sheep cannot deliver.
2. **Results flow up through structured channels.** Shepherds act on settled, paginated responses and committed artifacts — never on terminal scrollback, partial state, or a worker's reasoning transcript.
3. **Approval never flows down implicitly.** Reaching a milestone never grants authority, and the Shepherd's acknowledgement of a plan is a separate, explicit control.

## Topology

```text
Shepherd (you — the single human approval authority)
    │
    ▼
Sheepdog (technical planning + governance)
├── shepherd-plan ──── sheep-plan          read-only research
└── shepherd-build
    ├── sheep-plan                         read-only research
    ├── sheep-build                        bounded implementation
    ├── shearer-review-low                 independent review, low reasoning
    └── shearer-review-medium              independent review, medium reasoning
```

## Roles and authorities

| Agent | Tier | Direct mutation | Spawns | Git authority |
| --- | --- | --- | --- | --- |
| `shepherd-plan` | Strong (inherits active model) | Markdown plans, research notes, task briefs, handoffs | `sheep-plan` only | Markdown commits; current non-protected branch push |
| `shepherd-build` | Strong (inherits active model) | Markdown briefs, handoffs, review notes | All four leaf roles | Integration, push, PR, merge, delivery |
| `sheep-plan` | Fast worker (`litellm/glm-5.3-flash`) | None | None | Read-only inspection |
| `sheep-build` | Fast worker (`litellm/glm-5.3-flash`) | Assigned implementation | None | Local task commit only |
| `shearer-review-low` | Reviewer (`litellm-responses/gpt-5.6-terra`, low) | None | None | Read-only inspection |
| `shearer-review-medium` | Reviewer (`litellm-responses/gpt-5.6-terra`, medium) | None | None | Read-only inspection |

Model tiers are deliberate. Shepherds run on the active strong model and inherit its reasoning behavior. Workers run on a fast, cheap model because their tasks are bounded and their outputs are validated. Reviewers run a dedicated independent model at fixed `low` and `medium` reasoning so review is never the same model grading its own family's homework.

The build shepherd chooses `low` review for localized mechanical changes with strong deterministic coverage. It chooses `medium` review for security, architecture, migrations, public APIs, deployment, concurrency, cross-component work, weak coverage, or material uncertainty.

## Governing controls

### Separate acknowledgement and milestone controls

Acknowledgement and progress are intentionally different mechanisms:

- **Acknowledgement** is the act of selecting `shepherd-build` in the session. Switching the agent approves the latest presented plan. Nothing else — not a worker finishing, not a check passing, not time passing — approves a plan.
- **Milestones** track progress: the plan header (`Plan-ID`, `Base-Commit`, `Status`), each `task_id` contract, each verified local task commit, and each review verdict.

Milestones never imply acknowledgement, and acknowledgement never auto-advances a milestone. `shepherd-build` startup reports the plan ID, approved base, and current HEAD, then inspects divergence from the approved base before delegating.

Final plans carry:

```text
Plan-ID: <short-project-topic>-<YYYYMMDD>-<sequence>
Base-Commit: <full commit hash>
Status: PROPOSED
```

### No chain of thought

Shepherds govern by contracts and results, not by reading worker reasoning. The `herdr_agent_response` tool returns only the latest completed final assistant message: intermediate tool-call steps, errors, ignored text, reasoning, and terminal rendering are excluded at the source. Reviewers likewise receive fresh bounded context — user goal, approved plan, task contract, base and implementation commits, diff, and verification results — never the worker conversation.

This keeps delegation bounded, keeps review independent, and keeps a shepherd's context small enough to govern many workers.

### Deterministic validation

Before requesting semantic review, the build shepherd runs or delegates deterministic repository-native checks (the repository's own check and test commands). Reviewers judge semantics and defects; deterministic coverage is confirmed first so review cycles are never spent discovering what a test would have caught.

### Review

Reviewer verdicts are:

- `PASS`: integrate after shepherd checks.
- `REWORK`: return actionable findings to the responsible sheep and review the correction.
- `ESCALATE`: research, re-plan, or request Shepherd judgment.

Two failed semantic review cycles for the same task escalate instead of looping indefinitely.

### Escalation

Task contracts carry explicit `escalate_if` conditions. Workers must escalate rather than guess when evidence contradicts the assignment, ownership must expand, a public API or migration changes unexpectedly, a product or architecture decision is needed, permissions block required work, or repeated attempts fail. Shepherds resolve what repository evidence permits and surface unresolved product choices to the Shepherd — the human — for judgment. `unknown` is treated as inconclusive, never complete.

### Local integration and conflict delegation

Parallel `sheep-build` workers each get a dedicated branch and worktree with non-overlapping ownership and an explicit integration order. Integration itself, and every conflict it surfaces, belongs to `shepherd-build`: it resolves mechanical drift by reporting deviations, and resolves real conflicts by re-scoping ownership or issuing bounded recovery tasks to the responsible sheep. Sheep never push, merge, open PRs, or deliver; all integration stays local until the delivery authority pushes.

## Persistence and the Git common dir

All durable orchestration state lives in **Git**, not in agent memory or plugin process state:

- Plans, research notes, task briefs, handoffs, and review notes are committed Markdown artifacts.
- Worker output is a verified local commit; progress is Git history, reviewable and revertable.
- Every worktree the flock creates — including worktrees created from other worktrees — is a **peer that shares the same Git common repository**, never a nested checkout. Committed state is visible to every worktree immediately, so a plan written in one worktree governs workers in all of them, and orchestration state survives session ends, process restarts, and machine reboots.

Everything not in Git is explicitly ephemeral: `SHEPHERD_MODE` is injected per OpenCode session and dies with the session; response cursors are HMAC-signed with a per-plugin-process secret, expire after six hours, and do not survive a restart of the shepherd's OpenCode plugin process. If durable state matters, it must be committed.

## Git authority

| Mode (session agent) | Hook behavior |
| --- | --- |
| `plan` (`shepherd-plan`) | Allows only the attached current branch to the same non-protected remote branch |
| `build` (`shepherd-build`) | Does not add planning restrictions; the delivery authority owns remote Git |
| `sheep-plan` | Denies every push |
| `sheep-build` | Denies every push |
| `review` (shearers) | Denies every push |
| Missing/unknown | Does not interfere with normal human Git use |

The hook rejects detached-HEAD planning pushes, protected branches, ref renames, unrelated refs, and deletions. `main` and `master` are always protected in planning mode; add repository-specific branches:

```bash
git config --add orchestration.protectedBranch production
git config --add orchestration.protectedBranch release
```

### Security boundary

The hook and OpenCode Bash matchers are defense in depth, not a security sandbox. A process with arbitrary local command execution may be able to alter environment variables, Git configuration, hooks, or invoke remote protocols outside ordinary `git push`. Keep server-side protected branches and repository permissions as the authoritative control. A future integration can strengthen mode provenance with signed, session-scoped policy data, but cannot replace remote authorization.

## Response topology

The `herdr_agent_response` OpenCode tool retrieves completed responses from Herdr-managed OpenCode workers without reading terminal scrollback or creating response files. Only `shepherd-plan` and `shepherd-build` may call it, with a second authorization check inside the tool, and only for settled Herdr targets with a trusted `herdr:opencode` session mapping and an approved leaf role.

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
  "role": "sheep-build",
  "finish": "stop",
  "offset": 0,
  "nextOffset": 8192,
  "totalBytes": 24500,
  "complete": false,
  "cursor": "<opaque-signed-cursor>",
  "text": "..."
}
```

Shepherds must continue until `complete` is true before acting on the response. Pages use UTF-8 byte offsets and never split a multibyte character.

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
- interactively asks which models the shepherd, sheep worker, and shearer reviewer roles should use when run in a terminal;
- preserves existing JSONC comments, trailing commas, plugins, and tuple options;
- adds the stable file URL required by current OpenCode npm plugin loading;
- creates timestamped backups of changed config and npm manifest files;
- validates `shepherd-build` through a short-lived OpenCode debug process;
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

`configure-agents` updates the same model choices after installation. Press Enter to keep the displayed value, or enter `-` to restore that role's package default. Model names must include their provider prefix, such as `anthropic/claude-sonnet-4-6`. The sheep worker reasoning effort accepts the provider's variant names, such as `low`, `medium`, or `high`; leaving it unset uses the model's default reasoning behavior. Shepherd agents always inherit the active model and its reasoning behavior, and reviewer reasoning stays fixed at `low` and `medium`.

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

The expected package agents are `shepherd-plan`, `shepherd-build`, `sheep-plan`, `sheep-build`, `shearer-review-low`, and `shearer-review-medium`.

## Breaking migration: remove stale agent files

**Before updating to the current package, remove stale standalone agent files.** Agent definitions are merged by agent name, so a leftover local file with the same name as a package agent silently overrides the corresponding package fields, including its prompt and permissions.

- Archive or remove standalone files named `sheep-plan.md`, `sheep-build.md`, `shepherd-plan.md`, or `shepherd-build.md` after any existing OpenCode processes that depend on them have ended.
- Older misspelled files such as `sheperd-plan.md` and `sheperd-build.md` do not override the correctly named package agents; they load as additional legacy agents until removed. Delete them as well.
- Do not remove agent files merely to affect an already-running process. Complete or stop that process first, update the files, then start a new OpenCode process and verify the effective agent list with `opencode agent list`.

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
        "workerModel": "litellm/glm-5.3-flash",
        "workerVariant": "medium",
        "reviewerModel": "litellm-responses/gpt-5.6-terra"
      }
    ]
  ]
}
```

Machine-specific `shepherd-build` permissions and instructions can also be added declaratively without a local JavaScript wrapper:

```jsonc
{
  "plugin": [
    [
      "opencode-herdr-orchestration",
      {
        "shepherdBuildPermissions": {
          "private_deployment_status": "allow"
        },
        "shepherdBuildPromptAppend": "Use private deployment tools according to local policy."
      }
    ]
  ]
}
```

`shepherdBuildPermissions` is merged over the package's `shepherd-build` permissions. `shepherdBuildPromptAppend` is appended as a separate final paragraph. Keep secrets out of plugin options because configuration may be displayed by diagnostics.

Machine- or organization-specific MCP tools, deployment rules, and private service instructions should stay in a local `shepherd-build` override rather than this public package. Add only the private permissions and prompt additions required by your environment; unspecified package defaults remain intact through deep merging.

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

Herdr currently exposes `send-keys`, not a narrower agent interrupt command. Shepherds retain it to send Ctrl+C only after confirming that a worker is genuinely stuck. Prompts prohibit using worker terminals to type implementation commands or bypass shepherd permissions.

This restriction is not hard-enforced by Herdr. A native `herdr agent interrupt <target>` command would close that capability gap.

## Development

```bash
npm run check
npm test
```

Tests cover topology, model variants, permissions, override merging, session mode isolation, response selection, signed cursors, UTF-8 pagination, concurrent response reads, tool authorization, and Git hook behavior on protected, worker, review, build, and planning pushes.

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
- PR commands are narrowly available to `shepherd-build`, but work only in GitHub repositories with an authenticated `gh` installation.
- Agent registration and environment hooks take effect only in newly started OpenCode processes.
- Worker session exports are capped at 64 MiB by default to bound host memory use. The response tool returns `SESSION_EXPORT_TOO_LARGE` rather than loading a larger session.
