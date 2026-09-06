---
title: Changelog
layout: default
---

# Changelog

GitHub generated release notes are the canonical record for each release; the entries below summarize user-facing changes per version.

## 0.3.2

Adds a read-only launcher diagnostic that reports the winning launcher, ordered candidates, per-candidate versions, spawn probe, and integration presence with operator remedies, without changing state.

## 0.3.1

Adds Developer steering through the native `/steer` command as a second entry point alongside the submission tool, sharing one allowlist with direct writes through the existing state service and identical validation.

## 0.3.0

Delivers shared orchestration state under the canonical store with compatible reconciliation of older state, a per-plan Developer steering queue with check, read, and ownership-gated consume flow, planning-to-governance ownership handoff with generation fencing and disposition-tracked synchronization, documented pane placement with reuse-first behavior, project agent permission helpers with a human-invoked governance skill, and troubleshooting plus recovery guidance for integration, launcher resolution, and interrupted operations.

## Releases

Releases are cut from tags shaped `vMAJOR.MINOR.PATCH`. Publishing is gated on an exact match between the tag and `package.json`, reruns all checks, publishes to npm with provenance, and creates the GitHub release. Publishing uses the protected `npm` environment with an authorized token, and stays retry-safe by skipping republication when the same version from the same commit already exists while failing closed when the version came from another commit. Prerelease tags are not published.

## Known limitations

For current operational limits and workarounds, see Troubleshooting; the README keeps only a short bullet summary while detail lives alongside the troubleshooting guidance and this changelog.

## Docs navigation

- [Home](./)
- [Getting Started](./getting-started.html)
- [CLI Reference](./cli-reference.html)
- [Configuration](./configuration.html)
- [Troubleshooting](./troubleshooting.html)
- [Architecture](./architecture.html)
- [Contributing](./contributing.html)
- [Changelog](./changelog.html)
