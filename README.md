# flocky

[![CI](https://github.com/CodingJinxx/flocky/actions/workflows/ci.yml/badge.svg)](https://github.com/CodingJinxx/flocky/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@codingjinxx/flocky.svg)](https://www.npmjs.com/package/@codingjinxx/flocky)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

Capability-separated OpenCode agents for planning, implementation, independent review, and delivery through Herdr, organized as **Developer → Shepherd → Flock**. This package registers the agents, provides structured worker-response retrieval, injects session-specific orchestration mode into shell environments, and ships a reproducible Git `pre-push` policy for new and existing repositories.

Requires Node.js 20 or newer when running the package CLI or tests.

## Quickstart

You need Node.js 20 or newer, a working OpenCode install, and Herdr on the stable channel. Keep one interactive terminal available because the first install prompts for per-role model choices.

### Install

Install or update with the cross-platform npm CLI:

```bash
npx -y @codingjinxx/flocky@latest install
npx -y @codingjinxx/flocky@latest install --with-hooks
```

The first form installs the global OpenCode plugin entry and agent models. The second form also installs the shared Git push policy. For update, manual setup, stale file migration, and full options, see [Getting Started](docs/getting-started.md) and [CLI Reference](docs/cli-reference.md).

### Restart

After every install, update, manual edit, or agent-file cleanup, quit and restart OpenCode intentionally when ready. OpenCode loads plugins and agent definitions only at startup, and the installer never restarts a running process. Details live in [Getting Started](docs/getting-started.md) and [Configuration](docs/configuration.md).

### Verify

Confirm the installed agents:

```bash
opencode agent list
```

The expected package agents are `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, and `shearer-medium`. When any role is missing, see [Getting Started](docs/getting-started.md), [CLI Reference](docs/cli-reference.md), and [Troubleshooting](docs/troubleshooting.md). For read-only launcher diagnostics, run `node bin/orchestration.js doctor` and see [CLI Reference](docs/cli-reference.md) and [Troubleshooting](docs/troubleshooting.md).

## Philosophy

There is exactly **one Developer: the human operator**, and the Developer sits above the Shepherd. The Developer owns intent, product judgment, risk tolerance, and every final approval. No agent replaces the Developer; the Shepherd and every agent below it only prepare decisions for the Developer.

The Developer works through the Shepherd's two technical phases, each a registered agent:

- `shepherd` — the **planning** phase. Researches the repository through read-only workers and presents implementation-ready plans. It never implements.
- `shepherd-governor` — the **governance** phase. Approves plans by taking over the session, contracts bounded work, judges results, review verdicts, and escalations, and owns everything remote: pushes, merges, PRs, and delivery.

The **Flock** is the bounded workforce herded under those phases:

- `sheepdog` — herds the working flock: prepares worker branches and worktrees, drives delegation, watches progress, retries leaves, runs deterministic validation, selects the review tier, recovers conflicts by re-scoping ownership, and performs local integration under the governor's contracts.
- `grazer` — read-only research workers that graze the repository for evidence.
- `sheep` — bounded implementation workers that produce verified local commits.
- `shearer-low` / `shearer-medium` — independent read-only reviewers.

Three invariants govern the whole system:

1. **Authority flows down, never sideways or up.** Each role may mutate only what its authority permits. A worker cannot delegate beyond its assignment; a reviewer cannot mutate; the flock cannot deliver.
2. **Results flow up through structured channels.** Shepherd-phase agents act on settled responses and committed artifacts — never on terminal scrollback, partial state, or a worker's reasoning transcript.
3. **Approval never flows down implicitly.** Reaching a tracked step never grants authority, and the Developer's acknowledgement of a plan is a separate, explicit control.

For the full mental model, acknowledgement handling, review outcomes, escalation rules, and storage behavior, see [Architecture](docs/architecture.md).

## Topology

The diagram below shows reporting lines only. Authority flows down from the human operator through the two Shepherd phases to the working flock.

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

## Roles

| Agent | Tier | Direct mutation | Spawns | Git authority |
| --- | --- | --- | --- | --- |
| `shepherd` | Strong (inherits active model) | Markdown plans, research notes, task briefs, handoffs | `grazer` only | Local Markdown commits only; no push |
| `shepherd-governor` | Strong (inherits active model) | Markdown briefs, handoffs, review notes | `grazer`, `sheepdog` | Integration, push, PR, merge, delivery |
| `sheepdog` | Fast worker (`litellm/glm-5.3-flash`) | None | `grazer`, `sheep`, `shearer-low`, `shearer-medium` | Local integration of worker output; no push |
| `grazer` | Fast worker (`litellm/glm-5.3-flash`) | None | None | Read-only inspection |
| `sheep` | Fast worker (`litellm/glm-5.3-flash`) | Assigned implementation | None | Local task commit only |
| `shearer-low` | Reviewer (`litellm-responses/gpt-5.6-terra`, low) | None | None | Read-only inspection |
| `shearer-medium` | Reviewer (`litellm-responses/gpt-5.6-terra`, medium) | None | None | Read-only inspection |

Model tiers are deliberate. The two shepherd-phase agents run on the active strong model because planning and governance are the judgment-heavy work. Flock workers run on a fast, cheap model because their tasks are bounded and validated. Shearers run a dedicated independent model at fixed `low` and `medium` reasoning so review is never the same model grading its own family's homework. The squad lead selects the low tier for localized mechanical changes with strong deterministic coverage and the medium tier for security, architecture, migrations, public APIs, deployment, concurrency, cross-component work, weak coverage, or material uncertainty.

## Known limitations

- OpenCode command patterns cannot prove semantic Git intent; the hook adds checks but server-side protection is still required.
- `herdr agent send-keys` is broader than interrupt-only authority; the squad lead narrows it to Ctrl-C-only spellings as far as matchers permit, but matchers cannot prove intent and the prompt inspect-first rule stays primary.
- Global `core.hooksPath` is singular. Existing hook frameworks must be composed rather than overwritten.
- PR commands are narrowly available to the governance phase, but work only in GitHub repositories with an authenticated `gh` installation.
- Agent registration and environment hooks take effect only in newly started OpenCode processes.
- Worker session exports are capped at 64 MiB by default to bound host memory use. The response tool returns `SESSION_EXPORT_TOO_LARGE` rather than loading a larger session.

For workarounds, launcher resolution, integration checks, interrupted-operation handling, and legacy conflict review, see [Troubleshooting](docs/troubleshooting.md) and [CLI Reference](docs/cli-reference.md).

## Docs

Start with [Getting Started](docs/getting-started.md) for install plus update plus migration, then use the guides below for daily work. Detail lives in docs so this landing page stays short. Published site: https://codingjinxx.github.io/flocky/

- [Home](docs/index.md) — docs landing with navigation to every guide.
- [Getting Started](docs/getting-started.md) — install, update, manual setup, stale file migration, and verify steps.
- [CLI Reference](docs/cli-reference.md) — every package command with flags, including `doctor` diagnostics.
- [Configuration](docs/configuration.md) — global plugin entries, model tuples, local additions, and project permissions.
- [Troubleshooting](docs/troubleshooting.md) — integration checks, launcher resolution, interrupted-operation handling, and legacy conflicts.
- [Architecture](docs/architecture.md) — condensed mental model, governing behavior, and storage overview.
- [Contributing](docs/contributing.md) — checks, scoped changes, and pull-request expectations.
- [Changelog](docs/changelog.md) — user-facing release summaries with canonical GitHub notes.

Development checks are `npm run check` and `npm test`. Contribution workflow and scope rules live in [Contributing](docs/contributing.md). Release history lives in [Changelog](docs/changelog.md).
