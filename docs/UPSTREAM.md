# Upstream and Fork Maintenance

This document is for whoever maintains this fork. It records what upstream it
tracks, how to move it forward, and how to undo the one local patch when it
stops being needed.

## Upstream

| | |
|---|---|
| Upstream repository | https://github.com/tintinweb/pi-subagents |
| Upstream branch | `master` (the upstream default; this fork's `main` carries it) |
| Fork repository | https://github.com/taineng1919/pi-subagents |
| Fork base SHA | `e955e29c51b7a6cce37e1108cd2d6c57a77e151c` |
| Fork base description | `fix: stand down for lowercase workflow tools (#283)` — v0.19.0 + 1 upstream commit |
| Patch branch | `feat/workflow-rpc-observability` (PR into this fork's `main`) |

`main` is a byte-for-byte copy of upstream `master` at the base SHA above. All
fork changes live on the patch branch, never on `main`, so a rebase is a
fast-forward of `main` plus a replay of one commit.

## Patch purpose

`SubagentWorkflow` returns its tool result before its children run. In the
interactive TUI the inline workflow card follows the run live; on the RPC
channel there was nothing between the tool call and the delayed completion
notification. Paseo 0.8.0 renders a Pi extension's `ui.notify` frames as
in-thread timeline items, so the fork announces each child's transitions
(`⟳` running, `✔` done, `✘` failed) on that channel, including the effective
model and thinking level once the child's session resolves.

The patch is scoped to notification only:

- notifications are sent only when `ctx.mode === "rpc"`; the TUI path is untouched;
- notification failures are swallowed, so observability can never fail a run;
- workflow ownership, concurrency, resume, abort and result handling are unchanged;
- nothing is injected into the LLM context.

## Files the patch touches

| File | Change |
|---|---|
| `src/index.ts` | `workflowNotice()` formats the per-milestone line; `runWorkflowTask()` feeds it fresh milestones on the RPC channel and swallows channel errors. |
| `src/workflow/progress.ts` | `WorkflowAgentMilestone`, `agentMilestone()`, `isResolved()`, `WorkflowMilestoneTracker` (dedupe per row + milestone + attempt + effective configuration). |
| `src/ui/workflow-card.ts` | `agentStatSegments()` gains an opt-in `{ thinking: true }`; the inline card keeps the old output. |
| `test/workflow-progress.test.ts` | Tracker and milestone unit tests. |
| `test/workflow-rpc-notify.test.ts` | End-to-end wiring: transitions, resolution refresh, failure levels, fail-open, TUI silence. |

## Rebase onto a newer upstream

```sh
git remote add upstream https://github.com/tintinweb/pi-subagents.git   # once
git fetch upstream
git checkout main
git merge --ff-only upstream/master        # main stays an exact copy
git push origin main
git checkout feat/workflow-rpc-observability
git rebase main                             # replay the single patch commit
npm ci
npm run lint && npm run typecheck && npm test
```

Conflict guidance: the patch depends on the progress-entry shape
(`WorkflowAgentEntry`, `updateWorkflowProgressBatch`'s batch callback) and on
`agentStatSegments()`. If upstream moves those, re-anchor the patch there
rather than reimplementing the notification path; the intended seam is the
`onProgress` callback in `runWorkflowTask()`.

After a rebase, update the base SHA in this file and force-push the branch
(`git push --force-with-lease origin feat/workflow-rpc-observability`).

## Rollback

Disable the patch without touching upstream code:

- `git revert <patch-commit>` on the branch and merge that into `main`, or
- install this fork's `main` instead of the patch branch, or
- switch back to the published upstream package (`npm:@tintinweb/pi-subagents`).

Reverting the patch removes notifications only; no workflow behavior changes,
so there is no state to migrate either way.
