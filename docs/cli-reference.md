---
title: CLI Reference
layout: default
---

# CLI Reference

This page documents every `@ia-forge/flocky` package command exactly as implemented in `bin/orchestration.js`. For the install plus upgrade walkthrough, see [Getting Started](./getting-started.html).

Live versions at verification time were package `0.3.2`, OpenCode `1.18.29`, Herdr `0.8.2`, channel `stable`, and integration `opencode: current (v10)`. When command output disagrees with this page, trust the live output from `status` and `doctor`.

## Usage

```text
Usage: flocky <install|update|configure-agents|status|doctor|uninstall|install-hooks|uninstall-hooks> [--with-hooks] [--force]
```

Invoke through the published package or from a checkout:

```bash
npx -y @ia-forge/flocky@latest <command>
node ./bin/orchestration.js <command>
```

## Command table

| Command | Purpose | Hooks flag | Notes |
| --- | --- | --- | --- |
| `install` | Install the bundled package version and configure the global OpenCode plugin entry | `--with-hooks` also installs the Git policy | Prompts for agent models on an interactive terminal |
| `update` | Install the newest published package version and refresh the plugin entry | `--with-hooks` also installs the Git policy | Preserves comments plus tuples, validates, backs up |
| `configure-agents` | Revisit shepherd plus sheepdog plus worker plus reviewer model choices | Not applicable | Requires a prior install; Enter keeps a value, `-` restores default |
| `status` | Report CLI plus installed plus latest versions, config file, detected agents, obsolete files, and hook state as JSON | Not applicable | Read-only except for the latest-version lookup |
| `doctor` | Report read-only Windows launcher diagnostics as JSON with a human summary | Not applicable | Never mutates environment, profiles, or files |
| `uninstall` | Remove the plugin entry, steer command, installed package files, and owned agent files | `--with-hooks` also removes the Git policy | Writes backups of touched manifests |
| `install-hooks` | Copy the `pre-push` hook to the stable user location and set global `core.hooksPath` | `--force` allows intentional replacement of an existing hooks path | Refuses to replace an unrelated hooks path without review |
| `uninstall-hooks` | Clear the global `core.hooksPath` setting and remove the installed hook when it points at this package | Not applicable | Leaves unrelated hooks paths untouched |

## Flags

The `--with-hooks` flag applies to `install`, `update`, and `uninstall`. With `install` or `update` it installs the Git policy after the package step. With `uninstall` it removes the Git policy after the package step. The `--force` flag applies to hook installation: when global `core.hooksPath` already points somewhere else, the command fails closed unless `--force` is given after the existing hook setup has been reviewed and composed.

## Command details

### Install

The `install` command uses the CLI's own bundled version, creates the global config directory when needed, installs that exact version there, writes the plugin entry without removing unrelated plugins, prompts for model values when both standard input and output are interactive terminals, validates every agent role through isolated OpenCode debug runs, writes the native steer command entry, reconciles obsolete package-owned agent files without deleting modified or unowned files, records the manifest, and optionally installs hooks. Model entries require a provider prefix such as `provider/model`. Reasoning variants accept provider names such as `low`, `medium`, or `high`; an empty value keeps the model default while shepherd phases always inherit the active model.

### Update

The `update` command follows the same steps as `install` except it resolves the newest published version through the registry instead of reusing the bundled version and it does not prompt for models. Existing JSONC comments plus tuple options stay preserved, changed config plus npm manifest files receive timestamped backups, and a validation failure restores the previous config before reporting the error. Afterward, run `configure-agents` when model choices should change and `status` to confirm installed versus latest versions, then quit and restart OpenCode intentionally.

### Configure-agents

The `configure-agents` command requires the package to be installed under the global config directory. It prompts for the same seven model roles as `install`, rewrites only the orchestration plugin options while preserving unrelated keys, revalidates through OpenCode debug, restores the prior file when validation fails, and asks for an intentional OpenCode restart afterward.

### Status

The `status` command prints a single JSON object describing package plus hook health. Reported fields include the package name, CLI version, installed version, latest registry version plus lookup errors, whether an update is available, the resolved config file, whether the plugin plus steer command are configured, detected agents with an overall ready flag, obsolete agent files needing manual review, and hook state with configured path plus expected path plus installed flag plus active flag. Healthy output on the verified versions shows all seven packaged agents detected, ready true, and installed matching latest `0.3.2`.

### Doctor

The `doctor` command is a first-class diagnostic and is always listed alongside `status`. It inspects Windows launcher resolution without changing state: ordered candidates from resolver output, per-candidate version probes, agreement across launchers, spawn-probe observation, integration presence, flapping signals, and read-only path entries. Reported integration health is `opencode: current (v10)`; the missing state is `opencode: not installed`. Healthy launcher output reports `1.18.29` from each candidate with no version split, Herdr resolving to a single binary at `0.8.2`, and no reappearing shim after a global update. Remedies are operator-executed text only: use the winning full executable path for current-session relief, apply a persistent user-chosen path reorder for a durable fix, then restart Herdr plus the terminal plus OpenCode intentionally when ready. This package never overwrites the global environment automatically.

### Uninstall

The `uninstall` command removes the native steer command entry, removes the orchestration plugin entry while preserving unrelated plugins, uninstalls the package from the global config directory, deletes only files proven package-owned by digest while reporting modified or unowned files for manual review, removes the manifest, and optionally removes hooks when `--with-hooks` is present. Backups are written for touched files.

### Install-hooks and uninstall-hooks

The Git policy procedure uses two focused commands. To enable the policy, run:

```bash
npx -y @ia-forge/flocky@latest install-hooks
```

This path copies the packaged `pre-push` hook into the stable user location below and points global `core.hooksPath` there:

```text
~/.config/opencode-herdr-orchestration/hooks
```

KEEP: the hooks location stays at the legacy `~/.config/opencode-herdr-orchestration/hooks` path; warn only on mismatch, do not migrate automatically.

From that point every new clone, initialized repository, and linked worktree receives the same policy automatically. When global `core.hooksPath` already holds a different value, the command reports the conflict and requires an explicit `--force` rerun only after the existing hook setup has been reviewed. To inspect hook state, use `status`. To disable the policy, run:

```bash
npx -y @ia-forge/flocky@latest uninstall-hooks
```

Removal clears the global setting only when it points at this package and deletes the installed hook directory; any unrelated hooks path is left unchanged with an explanatory message. In governance mode the policy always protects `main` plus `master`; repository-specific branches are added with:

```bash
git config --add orchestration.protectedBranch production
```

The hook plus shell matchers are defense in depth rather than a sandbox boundary, so server-side branch protection remains authoritative.

## Verify with related guides

After any command that changes configuration, quit and restart OpenCode intentionally because agent plus plugin configuration loads only at startup. Then confirm with `opencode agent list` for the seven packaged roles `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, and `shearer-medium`, plus `status` and `doctor` for machine-readable health. The end-to-end install plus migration narrative lives in [Getting Started](./getting-started.html).

## Docs navigation

- [Home](./)
- [Getting Started](./getting-started.html)
- [CLI Reference](./cli-reference.html)
- [Configuration](./configuration.html)
- [Troubleshooting](./troubleshooting.html)
- [Architecture](./architecture.html)
- [Contributing](./contributing.html)
- [Changelog](./changelog.html)
