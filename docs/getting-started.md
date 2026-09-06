---
title: Getting Started
layout: default
---

# Getting Started

This guide installs the `@codingjinxx/flocky` package, updates it safely, and removes leftover agent files from the previous architecture. For the full command list, see [CLI Reference](./cli-reference.html).

Live-verified versions used below were checked before printing: package `0.3.2`, OpenCode `1.18.29`, Herdr `0.8.2`, Herdr channel `stable`, integration `opencode: current (v10)`, Node.js `>=20` (host reported `v24.19.0`). When any version below disagrees with `opencode --version`, `node bin/orchestration.js status`, or `node bin/orchestration.js doctor`, trust the live command output.

## Prerequisites

The host needs Node.js 20 or newer, a working OpenCode installation at `1.18.29`, and Herdr at `0.8.2` on the `stable` channel. The global OpenCode directory is `~/.config/opencode` unless `OPENCODE_CONFIG_DIR` points elsewhere. Keep one terminal with an interactive prompt available because the first install asks which models each role should use.

Default model choices presented during setup are the shepherd phases inheriting the active OpenCode model, sheepdog plus sheep workers on `litellm/glm-5.3-flash`, and shearer reviewers on `litellm-responses/gpt-5.6-terra` with fixed `low` and `medium` reasoning. Model names keep their provider prefix, for example `anthropic/claude-sonnet-4-6`.

## Quick install

For most machines the cross-platform installer is the supported path:

```bash
npx -y @codingjinxx/flocky@latest install
```

To include the shared Git push policy in the same step, add the hooks flag:

```bash
npx -y @codingjinxx/flocky@latest install --with-hooks
```

During `install` the tool locates the global OpenCode config directory, installs that exact package version there, prompts for shepherd plus sheepdog plus worker plus reviewer model choices, preserves JSONC comments plus trailing commas plus existing plugins plus tuple options, records the stable file entry current OpenCode plugin loading requires, writes timestamped backups of touched config plus npm manifest files, and validates every agent role through a short-lived OpenCode debug run. The run never stops or signals a running OpenCode process.

## Restart rule

OpenCode reads plugins plus agents only at startup. After every install, update, manual edit, or agent-file cleanup, quit OpenCode fully and start it again intentionally when ready. Processes that were already running keep their previously loaded configuration until they are restarted. The installer never restarts OpenCode automatically.

## Update and upgrade

Never hand-edit the global config while an OpenCode process that depends on it is running. Complete or stop dependent processes first, then run:

```bash
npx -y @codingjinxx/flocky@latest update
npx -y @codingjinxx/flocky@latest configure-agents
npx -y @codingjinxx/flocky@latest status
```

The `update` step resolves the newest published version, installs it exactly, preserves comments plus tuples, creates fresh backups, revalidates all roles, and restores the previous config when validation fails. The `configure-agents` step revisits the same model prompts later: press Enter to keep the displayed value or enter `-` to return that role to its package default. The `status` step reports the CLI version, installed version, latest version, configured file, detected agents, and obsolete files so the operator can confirm whether another restart is needed.

Before moving to the current package, handle stale standalone agent files as described in the migration section below. The Git push policy remains opt-in during upgrades through `install --with-hooks` or the standalone `install-hooks` command, which refuses to replace an existing global `core.hooksPath` without an explicit `--force` after review.

## Manual installation

When the automated installer is unavailable, add the published package to `~/.config/opencode/opencode.json` or `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@codingjinxx/flocky"]
}
```

When a `plugin` list already exists, append the package name rather than replacing the list. Then install the exact package inside that config directory so the stable file entry can resolve it:

```bash
cd ~/.config/opencode
npm install --save-exact @codingjinxx/flocky@latest
```

Current OpenCode releases may record but not execute an npm plugin referenced only by bare package name. When that happens, keep the installed package in place and use its installed entry path in a plugin tuple instead:

```jsonc
{
  "plugin": [
    "file:///ABSOLUTE/PATH/TO/.config/opencode/node_modules/@codingjinxx/flocky/src/plugin.js"
  ]
}
```

Replace the placeholder path with the real absolute path on the host. Optionally enable the shared Git policy with the hooks command, then apply the restart rule above and confirm with `opencode agent list`.

## Stale agent file migration

Earlier releases shipped standalone agent files that are now retired. Because OpenCode merges local agent definitions by name over plugin defaults, a leftover file with a colliding name silently overrides the matching packaged prompt plus permissions even after a successful upgrade.

After dependent OpenCode processes have ended, archive or delete these names wherever they appear as local agent files:

- `shepherd-plan.md`
- `shepherd-build.md`
- `sheep-plan.md`
- `sheep-build.md`
- `shearer-review-low.md`
- `shearer-review-medium.md`
- Older misspelled variants such as `sheperd-plan.md` and `sheperd-build.md`, which otherwise load as extra legacy agents until removed.

Do not delete files merely to influence an already-running process. Finish or stop that process first, update the files, start a new OpenCode process, and verify the effective list:

```bash
opencode agent list
```

The expected packaged agents are `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, and `shearer-medium`. Deliberate local customizations with the same names are still permitted, but only when they are intentionally maintained rather than stale leftovers. The installer reports package-owned deletions separately from modified or unowned files that need manual review, and `status` lists remaining obsolete files.

## Verify the result

From the global config directory, the following checks confirm a healthy install on the verified versions:

```bash
opencode agent list
npx -y @codingjinxx/flocky@latest status
npx -y @codingjinxx/flocky@latest doctor
```

The agent list shows all seven packaged roles. The status output shows matching installed plus latest package versions with agents ready. The doctor output reports launcher candidates plus agreement plus spawn probe plus `opencode: current (v10)` integration presence plus flapping signals as JSON with a human summary. Full option details plus hook management live in [CLI Reference](./cli-reference.html).

## Docs navigation

- [Home](./)
- [Getting Started](./getting-started.html)
- [CLI Reference](./cli-reference.html)
- [Configuration](./configuration.html)
- [Troubleshooting](./troubleshooting.html)
- [Architecture](./architecture.html)
- [Contributing](./contributing.html)
- [Changelog](./changelog.html)
