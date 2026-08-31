# opencode-herdr-orchestration

Capability-separated OpenCode agents for planning, implementation, independent review, and delivery through Herdr.

This package registers the agents, provides complete structured worker-response retrieval, injects session-specific orchestration mode into shell environments, and ships a reproducible Git `pre-push` policy for new and existing repositories.

Requires Node.js 20 or newer when running the package CLI or tests.

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

### Migrating from standalone agent files

Agent definitions are merged by agent name. A local file with the same name as a package agent overrides the corresponding package fields, including its prompt and permissions.

Before switching completely, archive or remove standalone files named `sheep-plan.md`, `sheep-build.md`, `shepherd-plan.md`, or `shepherd-build.md` after any existing OpenCode processes that depend on them have ended. Older misspelled files such as `sheperd-plan.md` and `sheperd-build.md` do not override the correctly named package agents; they load as additional legacy agents until removed.

Do not remove agent files merely to affect an already-running process. Complete or stop that process first, update the files, then start a new OpenCode process and verify the effective agent list.

## Architecture

```text
shepherd-plan
└── sheep-plan

shepherd-build
├── sheep-plan
├── sheep-build
├── shearer-review-low
└── shearer-review-medium
```

| Agent | Direct mutation | Delegation | Git authority | Model |
| --- | --- | --- | --- | --- |
| `shepherd-plan` | Markdown planning artifacts | `sheep-plan` only | Markdown commits; current non-protected branch push | Active strong model |
| `shepherd-build` | Markdown handoffs/review notes | All four leaf roles | Integration, push, PR, merge, delivery | Active strong model |
| `sheep-plan` | None | None | Read-only inspection | `litellm/glm-5.3-flash` |
| `sheep-build` | Assigned implementation | None | Local task commit only | `litellm/glm-5.3-flash` |
| `shearer-review-low` | None | None | Read-only inspection | GPT-5.6 Terra, low |
| `shearer-review-medium` | None | None | Read-only inspection | GPT-5.6 Terra, medium |

The build shepherd chooses low review for localized mechanical changes with strong deterministic coverage. It chooses medium review for security, architecture, migrations, public APIs, deployment, concurrency, cross-component work, weak coverage, or material uncertainty.

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

Local agent definitions with the same names are merged over plugin defaults. This permits deliberate user customization without losing unspecified plugin permissions or prompts.

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

Add repository-specific protected branches:

```bash
git config --add orchestration.protectedBranch production
git config --add orchestration.protectedBranch release
```

`main` and `master` are always protected in planning mode.

## Push policy

The plugin tracks the selected agent per OpenCode session and injects `SHEPHERD_MODE` into that session's shell environment.

| Mode | Hook behavior |
| --- | --- |
| `plan` | Allows only the attached current branch to the same non-protected remote branch |
| `build` | Does not add planning restrictions; shepherd-build owns delivery |
| `sheep-plan` | Denies every push |
| `sheep-build` | Denies every push |
| `review` | Denies every push |
| Missing/unknown | Does not interfere with normal human Git use |

The hook rejects detached-HEAD planning pushes, protected branches, ref renames, unrelated refs, and deletions.

### Security boundary

The hook and OpenCode Bash matchers are defense in depth, not a security sandbox. A process with arbitrary local command execution may be able to alter environment variables, Git configuration, hooks, or invoke remote protocols outside ordinary `git push`. Keep server-side protected branches and repository permissions as the authoritative control. A future integration can strengthen mode provenance with signed, session-scoped policy data, but cannot replace remote authorization.

## Planning handoff

Final plans include:

```text
Plan-ID: <topic>-<YYYYMMDD>-<sequence>
Base-Commit: <full commit hash>
Status: PROPOSED
```

Switching the session to `shepherd-build` approves that plan. Build startup reports the plan ID, approved base, and current HEAD, then inspects divergence before delegation.

Implementation contracts include the objective, ownership and forbidden paths, dependencies, acceptance criteria, verification, escalation conditions, and required deliverables. `sheep-build` hands a verified local commit upward. `shepherd-build` runs deterministic checks before requesting semantic review.

Reviewer verdicts are:

- `PASS`: integrate after shepherd checks.
- `REWORK`: return actionable findings to the responsible sheep and review the correction.
- `ESCALATE`: research, re-plan, or request user judgment.

Two failed semantic review cycles escalate instead of looping indefinitely.

## Worker interruption

Herdr currently exposes `send-keys`, not a narrower agent interrupt command. Shepherds retain it to send Ctrl+C only after confirming that a worker is genuinely stuck. Prompts prohibit using worker terminals to type implementation commands or bypass shepherd permissions.

This restriction is not hard-enforced by Herdr. A native `herdr agent interrupt <target>` command would close that capability gap.

## Worker response retrieval

The `herdr_agent_response` OpenCode tool retrieves completed responses from Herdr-managed OpenCode workers without reading terminal scrollback or creating response files.

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
- supports concurrent shepherds without response files or shared mutable retrieval state;
- allows only `shepherd-plan` and `shepherd-build`, with a second authorization check inside the tool;
- accepts only settled Herdr targets with a trusted `herdr:opencode` session mapping and an approved leaf role.

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

The previous file helper may remain for already-running OpenCode sessions. Once those processes end and this plugin is active, it is no longer needed by new sessions.

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
