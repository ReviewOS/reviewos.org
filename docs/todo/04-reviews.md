# 04 - Reviews

The reason this project exists. Everything before it is scaffolding for this phase.

The standard to hold: reviewing a hundred-file diff should stay fast and legible, a review thread
should survive a force-push, and a large change should be reviewable as a stack of small ones.
Matching GitHub is the floor, not the goal.

## Models

- [x] `app/Models/PullRequest.ts`: `repository_id`, `number` (shares the issue sequence),
      `title`, `body`, `author_id`, `state` (open, closed, merged), `head_repository_id`,
      `head_branch`, `head_sha`, `base_branch`, `base_sha`, `merge_commit_sha`, `merged_at`,
      `merged_by_id`, `draft`, `mergeable_state`, `stack_parent_id`, `additions`, `deletions`,
      `changed_files`
- [x] `app/Models/PullRequestReview.ts`: `pull_request_id`, `reviewer_id`, `state` (pending,
      approved, changes_requested, commented, dismissed), `body`, `commit_sha`, `submitted_at`.
      The `commit_sha` is what makes a review dismissible when new commits land.
- [x] `app/Models/ReviewThread.ts`: `pull_request_id`, `path`, `line`, `start_line`, `side`
      (left, right), `original_line`, `original_commit_sha`, `resolved`, `resolved_by_id`,
      `outdated`
- [x] `app/Models/ReviewComment.ts`: `review_thread_id`, `review_id`, `author_id`, `body`
- [x] `app/Models/PullRequestReviewer.ts`: requested reviewers, users and teams, with the request
      time and who requested
- [x] Seeders that produce a realistic pull request: several commits, a few threads, one outdated

## Diffs

The engine everything else here depends on. Get it right before building UI on top.

- [ ] Compute diffs with `git diff` against the merge base, not the base tip. A diff against the tip
      shows changes the author did not make, which is the single most common way review UIs mislead.
- [x] Parse unified diff output into structured hunks: file, old and new ranges, line origins
- [x] Rename and copy detection
- [x] Binary files, mode changes, symlinks, and submodule bumps each render as themselves rather
      than as noise
- [ ] Large-diff strategy: collapse by default past a threshold, load file diffs on demand, and
      never send the whole thing to the browser at once
- [ ] Word-level highlighting inside changed lines
- [x] Whitespace-only changes hidden behind a toggle
- [x] Generated files (lockfiles, `.gitattributes` `linguist-generated`) collapsed by default
- [ ] Tests against real-world shapes: a moved file, a 5,000 line diff, a file with no trailing
      newline, mixed line endings

## Comment anchoring

The part that is genuinely hard, and the part reviewers notice when it is wrong.

- [x] A thread anchors to a path, a line, a side, and the commit it was written against
- [x] When new commits arrive, re-anchor threads by tracking the line through the intervening
      diffs. When the line is gone, mark the thread outdated and keep it readable rather than
      dropping it.
- [x] A thread on a line that a later commit restores becomes current again
- [x] Threads survive a force-push, which is the common case for a rebased branch
- [ ] Tests: rebase, amend, force-push, file rename, and the line moving within a file

## Reviews

- [x] `app/Actions/Pull/OpenPullRequestAction.ts` - from a compare view or after a push, including
      across forks
- [ ] `UpdatePullRequestAction.ts`, `ClosePullRequestAction.ts`, `ReopenPullRequestAction.ts`
- [ ] `RequestReviewAction.ts` for users and teams
- [x] `StartReviewAction.ts`, `AddReviewCommentAction.ts`, `SubmitReviewAction.ts` - comments are
      pending and private until the review is submitted, so a reviewer can work through a diff
      without sending a dozen notifications
- [x] `ResolveThreadAction.ts`, `UnresolveThreadAction.ts`
- [ ] `DismissReviewAction.ts` with a required reason
- [x] Suggested changes: a suggestion block in a comment that the author can commit in one click
- [ ] Review a single file at a time, with per-file viewed state that persists across visits
- [ ] `CODEOWNERS` parsing, and automatic review requests from it

## Merging

- [ ] Mergeability computed in the background rather than on page load, cached, invalidated on push
      to either branch
- [ ] Merge strategies: merge commit, squash, rebase. Each configurable per repository, with a
      default.
- [ ] `MergePullRequestAction.ts` enforcing protected branch rules: required approvals, required
      checks, no changes requested outstanding, conversation resolution
- [ ] Commit message templates for squash and merge, editable at merge time
- [ ] Auto-merge: merge as soon as requirements are met
- [ ] Delete the head branch on merge, optionally, and offer to restore it
- [ ] Conflicts reported with the conflicting files named, not just a boolean
- [ ] Tests: every strategy, every protection rule, and a race where two pull requests merge at once

## Stacked pull requests

The differentiator. Nothing else in this space handles it well.

- [ ] `stack_parent_id` makes a pull request depend on another
- [ ] A stacked pull request diffs against its parent's head, so it shows only its own changes
- [ ] The interface shows the whole stack, with each entry's position and state
- [ ] Merging a parent automatically retargets its children to the parent's base
- [ ] Merge the whole stack in order in one action, stopping cleanly if one fails
- [ ] Detect a stack from branch topology on push, and offer it, rather than requiring manual
      declaration
- [ ] Tests: a three-deep stack, merging out of order, and a parent closed without merging

## Views

- [ ] `resources/views/[owner]/[repository]/pulls/index.stx`
- [ ] `.../pull/[number].stx` - conversation, commits, checks, and files, as tabs over one page
- [ ] `.../pull/[number]/files.stx` - the review screen, and the most important screen in the product
- [ ] `.../compare/[...refs].stx`
- [ ] Components: `DiffView` (split and unified), `DiffFile`, `DiffHunk`, `ReviewPanel`,
      `ReviewThread`, `PullRequestHeader`, `MergeBox`, `StackIndicator`, `FileTreeSidebar`
- [ ] Keyboard navigation through files and threads, and submitting a review without the mouse
- [ ] The diff renders on the server; the browser gets HTML, not a diff library and a JSON payload

## Known issues

- [ ] The pull request view renders its not-found branch against seeded data. The route, the
      layout, the imports, and the query shapes are each proven to work in isolation on the same
      route, so the fault is somewhere in the full server script. A multi-line `import` in a
      `<script server>` block was one confirmed cause of a silently degraded script, and stx
      reports nothing when it happens: worth fixing in stx so the next person loses minutes
      rather than hours.
- [ ] Seeded pull requests have no bare repository behind them, so the diff is legitimately
      empty. Seeding should create a real repository with a couple of commits.
