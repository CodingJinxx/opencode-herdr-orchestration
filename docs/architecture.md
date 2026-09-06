---
title: Architecture
layout: default
---

# Architecture

This system lets one person direct a small team of focused helpers for planning, building, independent review, and delivery. The overview below is a mental model only. Contributors should read the implementation in the source tree rather than relying on these summaries; see [Contributing](./contributing.html) for how to work with the code.

## Philosophy

You are the Developer: the single human operator. You hold intent, product judgment, risk tolerance, and every final approval. No helper replaces you; every helper only prepares a decision for you.

The Shepherd is your planning and governance layer. In planning it studies the repository and presents a ready-to-build approach without changing code. In governance it turns an approved approach into bounded assignments, judges finished work, and owns remote delivery such as pushes and merges.

The Flock is the bounded workforce guided by the Shepherd. A coordination lead prepares isolated work areas, hands out small assignments, watches progress, retries failed work with the same owner, asks for independent review before integration, and brings finished work together locally. Around that lead are read-only researchers, builders who each own one small task, and independent reviewers who never change code.

Three ideas hold the whole design together:

1. Each role may only change what you allowed it to change. Helpers cannot hand off work beyond their assignment, reviewers cannot edit, and the flock cannot deliver on your behalf.
2. Choices are made from finished, saved work rather than from live chatter or half-seen progress. What counts is the saved plan, the local commit, and the reviewer note.
3. Finishing work never counts as approval. Approval is always a separate, explicit choice you make; progress tracking never grants permission by itself.

```text
You, the Developer
|
Shepherd, planning and governance
|
Coordination lead
|-- research helpers, read-only
|-- builders, one bounded task each
|-- independent reviewers, read-only
```

| Role | Helps you by | Limits |
| --- | --- | --- |
| Planning shepherd | Studies the repo and proposes a buildable approach | Never changes code and never delivers |
| Governance shepherd | Turns your approved approach into small assignments and judges results | Only this layer may deliver remotely |
| Coordination lead | Prepares work areas, assigns tasks, validates results, and joins work locally | Local joining only, never remote delivery |
| Research helper | Collects evidence from the repo | Read-only, never edits |
| Builder | Implements one assigned task as a verified local commit | Only its own assignment, local work only |
| Independent reviewers | Give a fresh judgment on finished work | Read-only, never edits |

## Governing behavior

Acknowledgement and progress tracking are kept apart. Your acknowledgement is the explicit move into governance that approves an approach; nothing else approves it for you. No finished task, successful check, review note, or time going by counts as acknowledgement. Milestones are tracked separately through the saved plan, each finished local commit, and each review note. Tracking never grants acknowledgement, and acknowledgement never auto-completes tracked work.

Review of finished work has three plain outcomes: ready to join, needs changes with concrete feedback for the same builder to address and have reviewed again, or needs your decision when the work raises a question the helpers cannot settle. The same task is not sent around forever; repeated unsuccessful review rounds are brought to you instead of looping.

Escalation rule: helpers raise an issue for your judgment rather than guessing when the evidence disagrees with the assignment, when the work would spill past its bounds, when a public interface or migration or deployment behavior would change unexpectedly, when a product or design choice is needed, when permissions block the work, or when repeated tries keep failing. Open questions stay open until you decide.

## State and storage

Durable work lives outside helper memory in shared repository storage and in Git history, so a plan written in one work area guides work in the others and survives restarts. The shared area holds two folders:

```text
shared-git-storage/
  flocky/
    plans/
    executions/
```

All saved updates are written atomically so readers never see a half-written file; an interrupted save leaves at most harmless temporary data that a later run cleans up and completes, and when two updates contend only one wins while the other reports a conflict instead of quietly overwriting, keeping history reviewable and recoverable.

Temporary details stay temporary and small: session context ends with the session, helpers act on saved results rather than on reasoning transcripts, reviewers receive only the bounded context they need to judge the change, and saved documents carry size bounds so one large artifact cannot exhaust the store.

## Docs navigation

- [Home](./)
- [Getting Started](./getting-started.html)
- [CLI Reference](./cli-reference.html)
- [Configuration](./configuration.html)
- [Troubleshooting](./troubleshooting.html)
- [Architecture](./architecture.html)
- [Contributing](./contributing.html)
- [Changelog](./changelog.html)
