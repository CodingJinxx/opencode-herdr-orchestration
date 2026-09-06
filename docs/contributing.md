---
title: Contributing
layout: default
---

# Contributing

Run `npm run check` for syntax validation followed by `npm test` for the Node test suite, and use `node bin/orchestration.js doctor` as a read-only launcher diagnostic that reports without changing state; the suite under `test/` exercises agents, permissions, response handling, state storage, steering and ownership, project configuration, launcher diagnostics, and hook behavior, so consult the test files themselves for the current coverage rather than a fixed list.

## Pull requests

Keep changes scoped to the task, preserve unrelated work, and inspect `git diff` plus `git status` before committing. Report the checks run and their results in the pull request, and leave delivery actions such as pushes, merges, and releases to maintainers.

## Docs navigation

- [Home](./)
- [Getting Started](./getting-started.html)
- [CLI Reference](./cli-reference.html)
- [Configuration](./configuration.html)
- [Troubleshooting](./troubleshooting.html)
- [Architecture](./architecture.html)
- [Contributing](./contributing.html)
- [Changelog](./changelog.html)
