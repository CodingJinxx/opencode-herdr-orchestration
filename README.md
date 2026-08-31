# opencode-herdr-orchestration

Capability-separated OpenCode agents for planning, implementation, independent review, and delivery through Herdr.

This package registers the agents, injects session-specific orchestration mode into shell environments, and ships a reproducible Git `pre-push` policy for new and existing repositories. Complete Herdr worker-response retrieval is intentionally not implemented yet.

## Architecture

```text
sheperd-plan
└── sheep-plan

sheperd-build
├── sheep-plan
├── sheep-build
├── shearer-review-low
└── shearer-review-medium
```

| Agent | Direct mutation | Delegation | Git authority | Model |
| --- | --- | --- | --- | --- |
| `sheperd-plan` | Markdown planning artifacts | `sheep-plan` only | Markdown commits; current non-protected branch push | Active strong model |
| `sheperd-build` | Markdown handoffs/review notes | All four leaf roles | Integration, push, PR, merge, delivery | Active strong model |
| `sheep-plan` | None | None | Read-only inspection | `litellm/glm-5.3-flash` |
| `sheep-build` | Assigned implementation | None | Local task commit only | `litellm/glm-5.3-flash` |
| `shearer-review-low` | None | None | Read-only inspection | GPT-5.6 Terra, low |
| `shearer-review-medium` | None | None | Read-only inspection | GPT-5.6 Terra, medium |

The build sheperd chooses low review for localized mechanical changes with strong deterministic coverage. It chooses medium review for security, architecture, migrations, public APIs, deployment, concurrency, cross-component work, weak coverage, or material uncertainty.

## Install the plugin

During local development, reference the source directly in the global OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///C:/Dev/opencode-herdr-orchestration/src/index.js"
  ]
}
```

After publishing, use the package name instead:

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
        "workerModel": "litellm/glm-5.3-flash",
        "reviewerModel": "litellm-responses/gpt-5.6-terra"
      }
    ]
  ]
}
```

Local agent definitions with the same names are merged over plugin defaults. This permits deliberate user customization without losing unspecified plugin permissions or prompts.

During migration, existing files such as `~/.config/opencode/agents/sheperd-build.md` continue to override the plugin prompt. Keep them while existing sessions depend on them. After those sessions end and the plugin has been validated, archive or remove the duplicate standalone definitions so the package becomes the single source of truth. Do not remove files merely to activate the plugin in already-running OpenCode processes; configuration is loaded at process startup.

OpenCode loads plugins and agent definitions at startup. Restart OpenCode when intentionally enabling or updating the plugin. The installer never stops or restarts an OpenCode process.

## Install the Git policy

Run once after installing or from this checkout:

```powershell
node C:\Dev\opencode-herdr-orchestration\bin\orchestration.js install-hooks
```

The command copies the hook to a stable user location and configures:

```text
~/.config/opencode-herdr-orchestration/hooks
```

as global `core.hooksPath`. Every new clone, initialized repository, and linked worktree then receives the same policy automatically.

The installer refuses to replace an existing global `core.hooksPath`. Review and compose existing hooks first; `--force` is available only for an intentional replacement.

Inspect or remove the setting:

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

The plugin tracks the selected agent per OpenCode session and injects `SHEPERD_MODE` into that session's shell environment.

| Mode | Hook behavior |
| --- | --- |
| `plan` | Allows only the attached current branch to the same non-protected remote branch |
| `build` | Does not add planning restrictions; sheperd-build owns delivery |
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

Switching the session to `sheperd-build` approves that plan. Build startup reports the plan ID, approved base, and current HEAD, then inspects divergence before delegation.

Implementation contracts include the objective, ownership and forbidden paths, dependencies, acceptance criteria, verification, escalation conditions, and required deliverables. `sheep-build` hands a verified local commit upward. `sheperd-build` runs deterministic checks before requesting semantic review.

Reviewer verdicts are:

- `PASS`: integrate after sheperd checks.
- `REWORK`: return actionable findings to the responsible sheep and review the correction.
- `ESCALATE`: research, re-plan, or request user judgment.

Two failed semantic review cycles escalate instead of looping indefinitely.

## Worker interruption

Herdr currently exposes `send-keys`, not a narrower agent interrupt command. Sheperds retain it to send Ctrl+C only after confirming that a worker is genuinely stuck. Prompts prohibit using worker terminals to type implementation commands or bypass sheperd permissions.

This restriction is not hard-enforced by Herdr. A native `herdr agent interrupt <target>` command would close that capability gap.

## Worker response retrieval

This repository does not implement `herdr_agent_response` or predeclare a permission for a nonexistent tool. The later feature should add the tool and explicitly allow it only for both sheperds. It should:

- resolve Herdr's tracked OpenCode session ID;
- retrieve structured OpenCode messages rather than terminal snapshots;
- pin continuation reads to a session and message ID;
- paginate on UTF-8-safe boundaries until `complete: true`;
- support concurrent sheperds without shared mutable output files;
- deny access from sheep and shearer roles.

Until that tool is added, do not remove an existing response helper needed by running configurations.

## Development

```bash
npm run check
npm test
```

Tests cover topology, model variants, permissions, override merging, session mode isolation, and Git hook behavior on protected, worker, review, build, and planning pushes.

## Known limitations

- OpenCode command patterns cannot prove semantic Git intent; the hook adds checks but server-side protection is still required.
- `herdr agent send-keys` is broader than interrupt-only authority.
- Global `core.hooksPath` is singular. Existing hook frameworks must be composed rather than overwritten.
- PR commands are narrowly available to `sheperd-build`, but work only in GitHub repositories with an authenticated `gh` installation.
- Agent registration and environment hooks take effect only in newly started OpenCode processes.
