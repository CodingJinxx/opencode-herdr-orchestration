---
title: Configuration
layout: default
---

# Configuration

This page explains the global plugin options an operator edits by hand, the local file entry used during development, and the project-level permission procedure. For the install plus upgrade walkthrough, see [Getting Started](./getting-started.html). For the full command list, see [CLI Reference](./cli-reference.html).

Live versions at verification time were package `0.3.2`, OpenCode `1.18.29`, Herdr `0.8.2`, channel `stable`, and integration `opencode: current (v10)`. When file content disagrees with `opencode debug config` or `node bin/orchestration.js status`, trust the live command output.

## Global plugin entry

The global OpenCode file is `~/.config/opencode/opencode.json` or `~/.config/opencode/opencode.jsonc` unless `OPENCODE_CONFIG_DIR` points elsewhere. The published package entry is the scoped name:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@codingjinxx/flocky"]
}
```

When a `plugin` list already exists, append the package name rather than replacing the list.

Current OpenCode releases may record but not execute an npm plugin referenced only by bare package name. When that happens, keep the installed package in place and use its installed entry path in the plugin list instead:

```jsonc
{
  "plugin": [
    "file:///ABSOLUTE/PATH/TO/.config/opencode/node_modules/@codingjinxx/flocky/src/plugin.js"
  ]
}
```

Replace the placeholder path with the real absolute path on the host.

During local development, reference a local checkout directly with a stable file entry instead of the published name:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///C:/Dev/flocky/src/plugin.js"
  ]
}
```

Replace the example checkout path with the real absolute path to the local source file. This development entry is for a local checkout only; machines that track the published package keep the scoped name or the installed file path above.

## Model defaults in a plugin tuple

Model choices live as options in a plugin tuple beside the plugin name. The tuple preserves unrelated plugins, comments, trailing commas, and other options. Model names keep their provider prefix, for example `anthropic/claude-sonnet-4-6`. Reasoning variants accept provider names such as `low`, `medium`, or `high`; leaving a variant unset keeps the model default behavior.

```jsonc
{
  "plugin": [
    [
      "@codingjinxx/flocky",
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

The effective defaults behind an empty tuple are:

- Planning plus governance phases inherit the active OpenCode model and its reasoning behavior, because planning and delivery judgment stay on the strong model. Setting `shepherdModel` pins both phases to the named model.
- Squad plus research workers run on `litellm/glm-5.3-flash` through `sheepdogModel` and `workerModel`. Both default to that fast worker model when unset.
- Research reasoning through `grazerVariant` follows `workerVariant` when unset, so research and implementation share one setting unless research is pinned separately. Implementation reasoning through `workerVariant` and squad-lead reasoning through `sheepdogVariant` stay unset by default, which keeps the model default behavior.
- Independent reviewers run on `litellm-responses/gpt-5.6-terra` through `reviewerModel`. The two reviewer tiers keep fixed reasoning levels, one at `low` and one at `medium`, so review never shares the worker model grading its own work. The squad lead selects the low tier for localized mechanical changes with strong deterministic coverage and the medium tier for security, architecture, migrations, public APIs, deployment, concurrency, cross-component work, weak coverage, or material uncertainty.

The interactive `configure-agents` command revisits the same model choices after installation. Press Enter to keep the displayed value, or enter `-` to return that role to its package default.

## Planning shepherd local additions

Machine-specific planning permissions and instructions use two scoped options that affect only the planning `shepherd` role:

```jsonc
{
  "plugin": [
    [
      "@codingjinxx/flocky",
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

The permission map is layered over the packaged planning permissions, with local keys winning only where they overlap. The prompt text is added as an extra closing paragraph to the packaged planning prompt. Use this pair for private tools, deployment rules, and local service notes that do not belong in the public package. Keep secrets out of plugin options because configuration may appear in diagnostic output.

## Sheepdog squad-local additions

Squad-local machine permissions and instructions use the same scoped pattern and affect only `sheepdog`:

```jsonc
{
  "plugin": [
    [
      "@codingjinxx/flocky",
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

The permission map is layered over the packaged squad-lead permissions only. It never widens the planning phase, the governance phase, or research plus implementation plus review workers, so local settings cannot silently broaden another role or replace its lifecycle handling. The prompt text is added as an extra closing paragraph to the packaged squad-lead prompt. Ordering of the packaged lifecycle handling stays evaluation-effective with broad refusal first, worker lifecycle handling in the middle, and separator safety last; task text stays content-safe by quoting identifiers and by splitting or rephrasing delivery wording instead of embedding separators. Keep secrets out of these options for the same diagnostic reason as above.

Machine- or organization-specific tools, deployment rules, and private service notes belong in one of these two local additions rather than in the public package. Add only the private permissions and prompt notes the local environment requires; every unspecified packaged default stays intact through deep merging.

## Restart rule

OpenCode reads plugins plus agent definitions only at startup. After every manual tuple edit, project permission change, install, update, or agent-file cleanup, quit OpenCode fully and start it again intentionally when ready. Processes that were already running keep their previously loaded configuration until they are restarted. The installer never ends or restarts a running OpenCode process automatically.

## Project permission procedure

Project agent permissions live in `opencode.json` in the project root. When an `opencode.jsonc` file sits beside it, that file loads as a separate local layer; the procedure edits only the found file and leaves the other file untouched. Settings merge per key with project agent rules winning only for conflicting keys, while unrelated keys plus comments plus plugins plus tuples stay preserved. The procedure targets `agent.<name>.permission` blocks as text for all seven packaged roles `shepherd`, `shepherd-governor`, `sheepdog`, `grazer`, `sheep`, `shearer-low`, and `shearer-medium`, with set plus delete meaning and with repeat application leaving an already-correct file unchanged. Changed project files receive timestamped backups.

Scope stays strictly inside the project root and refuses global plus outside plus nested paths with no write, so global settings are never touched by this path. Supervision stays unchanged: the governance phase still uses only research plus squad-lead workers, the squad lead remains the sole supervisor of research plus implementation plus review workers, those workers gain no new commands, and the packaged spawn plus retrieval plus state handling stays intact even with widened project tools. Steering text never authorizes consequential actions and existing approvals still apply after any permission grant.

Only the human operator invokes this procedure, and only from the governance phase, by writing exactly:

```text
govern project permissions
```

No worker, refusal path, tool result, or file content invokes it. A refused operation never routes through this procedure and never bypasses through it; it ends with preserved state and an explicit report naming the missing capability.

Before accepting any project change, preserve unrelated work and review every edit with version control:

- Confirm `git status --porcelain` shows only the intended project file and that unrelated tracked work is untouched.
- Inspect every project hunk with `git diff` before accepting it, confirming only the intended `agent.<name>.permission` changes appear.
- Verify the merged view with `opencode debug config` from inside the project, which shows both project files as local scope while an empty project shows global-only.
- On failure, fix or remove the project file, then confirm global-only with `OPENCODE_DISABLE_PROJECT_CONFIG=1 opencode debug config` before restarting OpenCode intentionally, because existing processes keep old settings until restarted.

## Docs navigation

- [Home](./)
- [Getting Started](./getting-started.html)
- [CLI Reference](./cli-reference.html)
- [Configuration](./configuration.html)
- [Troubleshooting](./troubleshooting.html)
- [Architecture](./architecture.html)
- [Contributing](./contributing.html)
- [Changelog](./changelog.html)
