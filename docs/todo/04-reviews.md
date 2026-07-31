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
- [x] Closing, reopening, and moving between draft and ready for review, as one
      `UpdatePullRequestStateAction` over a pure rules module (`state.ts`). Merged is terminal, a
      repeated transition changes nothing so a retry cannot rewrite who closed it, and a reopen
      whose head branch was deleted is refused rather than left with no diff.
- [x] `UpdatePullRequestAction.ts` for the title, body, and retargeting the base branch. Retargeting
      recomputes `base_sha` and re-derives `stack_parent_id`, because the base decides the merge
      base, which decides the diff every review thread is anchored against.
- [x] `RequestReviewAction.ts` for users and teams. Re-requesting after someone has replied is the
      useful case rather than an error, which is why the request row survives a submitted review:
      it clears `responded_at` instead of losing the record of the first ask.
- [x] `StartReviewAction.ts`, `AddReviewCommentAction.ts`, `SubmitReviewAction.ts` - comments are
      pending and private until the review is submitted, so a reviewer can work through a diff
      without sending a dozen notifications
- [x] `ResolveThreadAction.ts`, `UnresolveThreadAction.ts`
- [x] `DismissReviewAction.ts` with a required reason. The review is kept with its state changed
      rather than deleted, so the thread still reads in order, and the request it answered is
      reopened because a dismissal is a way of asking for another look.
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

## Reviewing at scale

Everything above makes one review possible. This section is about the reviewer who has eleven of
them waiting and forty minutes, which is the actual condition of the job and the thing no forge
treats as a first-class problem. If ReviewOS is going to claim the review is the primary object,
this is where the claim is either true or marketing.

- [ ] **Since I last looked.** A per-reviewer incremental diff: what changed between the commit you
      last reviewed and the head, not a commit range you have to assemble yourself. The re-anchoring
      work above is what makes this survive a force-push, which is the case that matters, because a
      rebased branch is where GitHub's version gives up and shows you the whole diff again.
- [ ] **Separate the mechanical from the meaningful.** Classify each hunk: a pure rename, a
      formatting-only change, a mass find-and-replace, a moved block, real logic. Collapse the first
      four by default and say how many were collapsed. A 4,000 line diff is usually 200 lines of
      decision inside 3,800 lines of consequence, and reading it linearly is the reason large
      changes get approved unread.
- [ ] Commit-by-commit review for branches whose history was written to be read, rather than forcing
      every change through one squashed view
- [ ] **The review queue is the home screen.** What is waiting on you, ordered by how long it has
      been waiting and how blocked the author is, plus what you are waiting on. A repository list as
      a landing page is a file browser's idea of a home screen.
- [ ] Suggested reviewers from who actually changed these lines, weighted by recency, not only from
      `CODEOWNERS`. Include current review load, so the suggestion does not always name the same
      person.
- [ ] Reviewer load and staleness visible to maintainers: which requests have gone unanswered, and
      by whom, as information rather than as a leaderboard
- [ ] **Coverage in the diff.** If CI uploads a coverage report, mark changed lines that no test
      executes. This changes the question a reviewer asks from "does this look right" to "what
      happens when this is wrong", which is the more useful question.
- [ ] Blame on context lines: why this line is here, linking the pull request that introduced it,
      without leaving the diff
- [ ] Review drafts survive leaving the page, closing the browser, and coming back on another
      machine. A lost half-written review is the reason reviews get sent as one line.
- [ ] Keyboard-first: next file, next thread, next unresolved, approve, request changes, submit,
      all without the mouse, and a command palette for everything else
- [ ] Tests: a force-push mid-review keeps the incremental diff correct, and classification does not
      hide a logic change inside a rename

## Views

- [ ] `resources/views/[owner]/[repository]/pulls/index.stx`
- [ ] `.../pull/[number].stx` - conversation, commits, checks, and files, as tabs over one page
- [ ] `.../pull/[number]/files.stx` - the review screen, and the most important screen in the product
- [ ] `.../compare/[...refs].stx`
- [ ] Components: `DiffView` (split and unified), `DiffFile`, `DiffHunk`, `ReviewPanel`,
      `ReviewThread`, `PullRequestHeader`, `MergeBox`, `StackIndicator`, `FileTreeSidebar`
- [ ] Keyboard navigation through files and threads, and submitting a review without the mouse
- [ ] The diff renders on the server; the browser gets HTML, not a diff library and a JSON payload

## Stacked pull requests

The workflow Meta built Phabricator around and Google calls chaining, described in
[The Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/stacked-diffs), and shipped by
GitHub in [public preview](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
in July 2026. Both agree on the mechanics, so this follows them rather than inventing a third model.

- [x] A stack is detected from branch topology: opening against another open pull request's branch
      is what makes it stacked. No naming scheme, no metadata file.
- [x] Each member diffs against its parent, so it shows only its own layer
- [x] Merging a member lands it and every unmerged layer below it, rather than refusing. Refusing
      is the wrong end of the stick: the merge takes those commits along regardless, so the honest
      thing is to land them and say so. (`landableThrough`)
- [x] Landing a whole stack in one action, bottom first, stopping at the first member that is not
      ready and reporting how far it got (`MergeStackAction`, `POST /api/repos/pulls/merge-stack`)
- [x] Children retarget automatically when a parent lands (`retargetStack`)
- [x] Orphan detection: a parent closed without merging, a parent that no longer exists, or a child
      that no longer sits on its parent's branch (`orphanReason`)
- [x] Which member below is holding this one up, named rather than described (`blockedBy`)
- [x] A stack map component showing position, state per layer, and where you are (`StackNav.stx`)
- [x] Wire `StackNav` into the review view. Two things had to be right: an array does not survive
      an stx attribute as itself (it stringifies, so the list is passed as JSON and parsed in the
      component), and an attribute arrives as a string, so the current id is coerced before it is
      compared with numbers.
- [ ] Automatic rebase of higher layers when a lower one lands, beyond retargeting
- [ ] Merge queue support for stacks

## Known issues

- [x] The pull request view rendered its not-found branch against seeded data. Two causes, both
      now fixed: a multi-line `import` in a `<script server>` block silently broke the whole
      script (fixed upstream in stx v0.2.126), and `innerJoin` was called with three arguments
      where the query builder takes four, `(table, left, operator, right)`. The thrown error was
      swallowed and the page rendered with every variable undefined; `STX_DEBUG=1` surfaces it.
- [ ] Seeded pull requests have no bare repository behind them, so the diff is legitimately
      empty. Seeding should create a real repository with a couple of commits.
