# Upstream and Fork Maintenance

This document is for whoever maintains this fork. It records what upstream it
tracks, which Git model the fork follows, and how to move it forward or undo the
local patch.

## Upstream

| | |
|---|---|
| Upstream repository | https://github.com/tintinweb/pi-subagents |
| Upstream branch | `master` (the upstream default; this fork's `main` carries it plus the patch) |
| Fork repository | https://github.com/taineng1919/pi-subagents |
| Fork base | official tag `v0.19.0` — `4f572eaa04c09d3dbc16e4a5f13a16b295e84e14` |
| Patch branch | `feat/workflow-rpc-observability` (PR #1, source of the patch) |

### Why the base is the v0.19.0 tag

Upstream `master` carried one unreleased commit past the tag when this fork was
made: `e955e29` (`fix: stand down for lowercase workflow tools (#283)`). The
installed package is the published 0.19.0, not that commit, and the base was
resolved from the installed artifact rather than from `package.json`:

- `npm view @tintinweb/pi-subagents@0.19.0 gitHead` reports
  `4f572eaa04c09d3dbc16e4a5f13a16b295e84e14`, the tag commit.
- Every `src/` file the published tarball ships (56 files) is byte-identical to
  the tag tree; `e955e29` differs in exactly one file
  (`src/workflow/collisions.ts`), which is the unreleased fix.

The fork therefore tracks the released source it is actually installed from.
`e955e29` is intentionally not part of the base.

## Long-term model

`main` carries upstream plus the local patch (mode 1):

- `main` sits at the exact upstream tag and gains the patch through the PR
  merge. Before that merge it is a byte-for-byte copy of the tag.
- Installations pin an explicit `main` SHA (or the upstream tag before the patch
  landed); no installation follows a floating branch.
- The patch branch is the PR's source and may be deleted once merged; later work
  starts from `main`.
- Moving upstream means replaying the patch commits on top of a newer upstream:
  rebase or merge `main` onto `upstream/master`, then re-run the checks.

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
| `docs/UPSTREAM.md` | This file. |

## Moving to a newer upstream

```sh
git fetch upstream --tags
git checkout main
git rebase upstream/master          # or: git merge upstream/master
npm ci
npm run lint && npm run typecheck && npm test
git push --force-with-lease origin main   # after a rebase; plain push after a merge
```

Conflict guidance: the patch depends on the progress-entry shape
(`WorkflowAgentEntry`, `updateWorkflowProgressBatch`'s batch callback) and on
`agentStatSegments()`. If upstream moves those, re-anchor the patch there
rather than reimplementing the notification path; the intended seam is the
`onProgress` callback in `runWorkflowTask()`.

Record the new tracked release (tag and SHA) in the table above when it moves.

## Rollback

Disable the patch without touching upstream code:

- `git revert <patch commits>` on `main`, or
- install the upstream tag/release directly instead of this fork's `main`.

Reverting the patch removes notifications only; no workflow behavior changes,
so there is no state to migrate either way.
