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

The rendering half of it now has its own phase: [14 - The diff engine](./14-diff-engine.md) covers
streaming, virtualization, worker highlighting, and the benchmark harness, written against
DiffsHub as the standard to beat. What stays here is the git-side correctness: what the diff *is*,
not how fast it draws. Two boxes below (the large-diff strategy and word-level highlighting) are
owned by that phase and are duplicated here on purpose, because a reader of this phase needs to know
they are somebody's problem.

- [x] Compute diffs with `git diff` against the merge base, not the base tip. A diff against the tip
      shows changes the author did not make, which is the single most common way review UIs mislead.
      Both paths do it: `load.ts` resolves the merge base explicitly, and `streamMergeBaseDiff` uses
      the three-dot form, which is the same thing in one command. There is a test holding the
      streamed one to it, against a history where the two answers genuinely differ.
- [x] Parse unified diff output into structured hunks: file, old and new ranges, line origins
- [x] Rename and copy detection
- [x] Binary files, mode changes, symlinks, and submodule bumps each render as themselves rather
      than as noise
- [x] Large-diff strategy: collapse by default past a threshold, load file diffs on demand, and
      never send the whole thing to the browser at once
- [x] Word-level highlighting inside changed lines
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
- [x] Per-file viewed state that persists across visits, and across machines. `ReviewedFile` is one
      row per reviewer per file per pull request, read once on load and written as boxes are ticked;
      ticking one folds the file away on the way back too, which is the half that makes it worth
      remembering. Local storage stays in front of it, so a signed-out reader keeps their place and a
      failed request costs nothing. See [phase 14](./14-diff-engine.md#the-file-tree).
- [ ] Review a single file at a time: a mode that shows one file and moves to the next, rather than
      one long scroll with the read ones folded
- [ ] `CODEOWNERS` parsing, and automatic review requests from it

## Merging

- [x] Mergeability computed with `git merge-tree --write-tree`, which merges in memory and cannot
      move a ref. There is a test holding it to that, because the alternative implementations
      (a temporary worktree, a real merge on a scratch branch) all can.
- [x] Cached against the two commits it was computed from, which is what makes "invalidated on
      push" fall out for free: the moment either side moves, the stored answer no longer matches.
      No hook has to remember to clear anything. An unknown answer is deliberately not cached, so a
      transient git failure retries instead of sticking.
- [x] Conflicts reported with the conflicting files named, not just a boolean. git already says
      which they are, so withholding them sends somebody to their terminal to rediscover what we
      know.
- [ ] Computed in the background rather than on page load. It is computed in the view for now; the
      cache makes that one merge per pair of commits rather than one per visit, but it still means
      the first visitor after a push waits for it. This needs the queue (phase 5 prerequisites).
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

- [x] **Since I last looked.** A per-reviewer incremental diff: what changed between the commit you
      last reviewed and the head, not a commit range you have to assemble yourself.

  Answered as a *list of files*, not a diff. The reviewer already has the diff on screen; what they
  are missing is which of its three hundred files their earlier conclusion no longer covers. So the
  endpoint returns paths and the sidebar filters what is already there, which also means no second
  copy of the patch crosses the wire.

  `git diff lastSeen head` is the obvious implementation and it is wrong twice over. Two tips
  compared directly carry every commit that landed on the base in between, so a reviewer who looked
  on Monday is shown a hundred files somebody else changed on Tuesday; and after a force-push the two
  tips share no history at all, so the answer is the whole branch. That is where GitHub gives up.

  What is compared instead is each head against **its own merge base** - the three-dot diff the pull
  request is already rendered from - and then the two patches, file by file. The same patch for a
  path means the proposal for that file has not moved, whatever happened underneath it. This is
  rebase-proof by construction rather than by special-casing: a rebase moves both merge bases, and a
  file the rebase did not touch produces the same patch byte for byte and drops out. A file the
  rebase *did* touch is named, which is correct - the change now applies to different surrounding
  code, and whether it still makes sense is a question only the reviewer can answer.

  A digest per path is held, never a patch, so this keeps the rule the rest of the diff engine is
  built on. `tests/e2e/since-last-look.test.ts` builds a repository, moves the base under the branch,
  rebases, force-pushes, and asserts the unmoved file is *not* put back in front of the reader -
  which is the only assertion in it that a naive implementation would fail.

- [ ] Advance "last looked" explicitly, so a reviewer can say they have caught up without submitting
      a verdict. It is currently the later of their last review and their last viewed-file mark,
      which is right for the common case and has no way to say "I have read this round".
- [ ] A line-level interdiff for a file that did change, rather than sending the reader back to its
      whole diff. `git range-diff` is the shape of the answer; rendering a diff of diffs in a viewer
      built for file diffs is the open question.
- [x] **Separate the mechanical from the meaningful.** Each hunk is classified as formatting only, a
      symbol renamed throughout, a block that moved unchanged, or logic. A file whose every hunk is
      mechanical *for the same reason* arrives folded with that reason on its header and in the
      sidebar, and the sidebar counts them: `5 files, 1 viewed, 2 mechanical`.

  **Said out loud** is the whole safety argument, not a nicety. A reviewer told "two mechanical" can
  open them and disagree; a reviewer silently shown less has been lied to about the size of what they
  approved. Nothing is ever removed from the diff.

  Every rule is conservative in the same direction, and the tests are mostly about what the
  classifier *refuses* to call mechanical, because a false "this is just a rename" hides a real change
  inside a diff somebody has been told is safe to skim. So: a substitution has to be identifier
  shaped on both sides, which is what stops `const limit = 1` becoming `2` reading as a rename; the
  same swap has to hold on *every* changed line, so eighty-nine renames and one real edit is logic; a
  moved run has to be at least three lines, or every closing brace in every language is a move; and a
  file that is mechanical two different ways gets no single reason, because the honest summary of it
  is the diff.

  A file that is only *partly* mechanical stays open and claims nothing. Folding it would hide the
  one line anybody needed to read behind a badge saying it was safe to skip.

  A file that is *half* formatting and half logic gets no badge of its own, so each mechanical hunk
  is labelled on its own separator instead - the row a reader's eye already stops at on the way into
  a hunk. Only there: a file already badged "formatting only" would repeat itself on every separator
  inside it, and noise is how a reader learns to stop reading badges.

- [ ] *Fold* the mechanical hunks, rather than only labelling them. Folding changes how many rows a
      file renders as, and that number is the same in three places by design - what `countRows`
      counts, what `renderDiffRows` emits, and what the client asks for by index. A fold is a change
      to all three at once plus a re-measure when the reader opens one, which is why the label
      shipped first.
- [ ] A block that moved between two *files* reads as a delete and an add. Detecting that needs the
      whole diff in view rather than one file, which the streaming manifest deliberately does not
      have.
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
- [x] Review drafts survive leaving the page, closing the browser, and coming back on another
      machine. A lost half-written review is the reason reviews get sent as one line. `ReviewDraft`
      holds one per reviewer per pull request, with the path, the side and the range beside the body
      - a draft restored without its anchor is a comment about code it is not about. A draft the
      reader is already typing into wins over one arriving from elsewhere, because taking their words
      away would be the failure this exists to prevent.
- [ ] Keyboard-first: next file, next thread, next unresolved, approve, request changes, submit,
      all without the mouse, and a command palette for everything else
- [ ] Tests: a force-push mid-review keeps the incremental diff correct, and classification does not
      hide a logic change inside a rename

## Views

- [x] `resources/views/[owner]/[repository]/pulls/index.stx`
- [ ] `.../pull/[number].stx` - conversation, commits, checks, and files, as tabs over one page
- [x] `.../pull/[number]/files.stx` - the review screen, and the most important screen in the product
- [ ] `.../compare/[...refs].stx`
- [ ] Components: `ReviewPanel`, `PullRequestHeader`, `MergeBox`, `StackIndicator`,
      `FileTreeSidebar`. `DiffView` and `ReviewThread` were components and are not any more: the
      same markup is needed by the streamed review screen, and a component cannot be called from a
      string. Both now come from `app/Actions/Pull/rows.ts` and `threads.ts`, which is one renderer
      rather than two that drift.
- [x] Keyboard navigation through files and threads, and submitting a review without the mouse
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
- [x] Seeded pull requests had no bare repository behind them, so the diff was legitimately empty.
      `./buddy seed:demo` now writes a real repository (two commits on `main`, three on a branch)
      and takes the shas from git rather than inventing them. It is idempotent, so running it twice
      reports what exists instead of duplicating.
- [x] With a real diff behind it, the review screen turned out to render nothing, for four separate
      reasons. Each is worth recording because each fails silently:
  - [x] `file="{{ file }}"` is string interpolation, so the object arrived as `[object Object]` and
        every field read as empty. `:file="file"` passes the value. Scalars survive either form,
        which is what let the mistake through review.
  - [x] `hidden="{{ collapsed }}"` rendered `hidden="false"`, and `hidden` is a boolean attribute:
        present at all means hidden. Every diff on the page was invisible. It is a class now.
  - [x] `tokensFor` and `threadsAt` were called inside `DiffView`, which has no `<script>` block and
        so imports nothing. They were undefined, and `@foreach` over undefined reported "is not
        iterable" into an HTML comment rather than anywhere anybody would look. The tokens and
        threads are attached to each line in the view, where the imports are, which also does the
        work once per line rather than once per render.
  - [x] The code cell is `white-space: pre`, so the template's own indentation was printed and every
        line started a dozen columns in
- [x] A `files.stx` route. The diff used to live behind a tab on the conversation page, so there was
      no way to link somebody to the review screen itself. It is now
      `/{owner}/{repository}/pull/{number}/files`, and it renders through the streamed engine from
      [phase 14](./14-diff-engine.md) rather than as a whole page.
