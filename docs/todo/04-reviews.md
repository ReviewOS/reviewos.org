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
- [x] Tests against real-world shapes: a moved file, a 5,000 line diff, a file with no trailing
      newline, mixed line endings. All four in `tests/unit/diff-shapes.test.ts`, alongside a quoted
      path, a path containing a newline, and a path containing a quote. The same box is ticked in
      [phase 14](./14-diff-engine.md) and satisfied by the same file.

## Comment anchoring

The part that is genuinely hard, and the part reviewers notice when it is wrong.

- [x] A thread anchors to a path, a line, a side, and the commit it was written against
- [x] When new commits arrive, re-anchor threads by tracking the line through the intervening
      diffs. When the line is gone, mark the thread outdated and keep it readable rather than
      dropping it.
- [x] A thread on a line that a later commit restores becomes current again
- [x] Threads survive a force-push, which is the common case for a rebased branch
- [x] Tests: rebase, amend, force-push, file rename, and the line moving within a file.
      `tests/e2e/thread-anchoring.test.ts` puts a thread on a line and then rebases and force-pushes
      for real; rename and line-movement are unit tests on `reanchor`.

  **Writing it found that every review comment on an added line was marked outdated the moment it
  was left.** Anchoring called `reanchor`, which maps a line *from the old side of a diff to the new
  side* - the right operation for tracking a thread from the commit it was written against to the
  current head, and the wrong one for the diff on screen, where a thread's line is already a
  position. A right-side line is a line of the head; mapping it as an old-side line lands on
  whatever occupies that number in the base, and for an added line there is nothing there at all.

  Commenting on the code being proposed is the most ordinary thing a reviewer does. Every one of
  those comments rendered as a relic of a version that never existed, and no test caught it because
  every existing anchoring test used a context line or the left side. `placeThread` is the correct
  operation and `reanchor` is left alone, because it is right about what it does.

- [x] Track a thread through the diff from the head it was written against to the current head, so a
      rebase that shifts a line carries the comment with it. `reanchor` was always the right
      operation and had never been handed the diff its own doc comment asks for; `loadReviewThreads`
      now resolves it.

  **Two dots, not three.** Three would silently do nothing after a rebase: the merge base of the old
  head and the new one moves with the rebase, so the intervening change vanishes from the answer and
  every thread reports itself unmoved. That is the same one-character mistake as the base-to-head
  diff, with the opposite sign, which is why `streamCommitRangeDiff` says so where it is defined.

  Grouped by `original_commit_sha`, so a pull request with forty threads from three rounds of review
  costs three `git diff` calls rather than forty, resolved once before the stream opens rather than
  per file. Threads already on the current head cost none, which is most of them.

  A sha that has been garbage collected after a force-push cannot be diffed, and that is not fatal:
  the thread stays where it was stored. A review that vanishes because git could not answer a
  question about it is worse than one that is a line out.

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
- [x] `CODEOWNERS` parsing, and automatic review requests from it. Read from the **base**, not the
      head: a pull request that adds itself to `CODEOWNERS` would otherwise choose its own reviewers,
      which is a way to be approved by nobody.

  GitHub's rules exactly, rather than improved on. A `CODEOWNERS` file is almost always copied in
  from somewhere else, so reading it differently is not a design choice - it is assigning the wrong
  people quietly. The three that a homegrown matcher gets wrong: **the last matching rule wins**, not
  the first and not all of them; a pattern with no slash matches at **any depth**, so `*.ts` is not
  top-level only; and `*` does not cross a slash while `**` does, which is why GitHub documents
  `/docs/*` as covering a directory's files and not its subdirectories.

  Writing the end-to-end fixture, I put the catch-all `*.md` at the bottom and it took `docs/guide.md`
  away from the docs owner - the exact mistake the unit tests warn about, made while writing the test
  for it. That is the argument for reading the rule exactly rather than the way it feels like it
  should work, and the fixture now says so where it orders the lines.

  The author is never asked to review their own change, which is most of what this does in practice:
  being named as the owner of a file you are changing is the normal case. A name matching nobody here
  - a team, an email address, somebody who has left - is skipped rather than failing the request,
  because refusing to open a pull request over a stale line in a checked-in text file would make an
  unrelated problem look like the forge being broken.

- [x] Resolve a team (`@org/team`) to its members. Teams parse and are carried through as owners
      rather than dropped, so the file is read faithfully; turning one into people is phase 1's
      model.

  `resolveOwners` in `codeowners.ts`: the organization by handle, the team by slug within it, the
  members through `team_members`. Resolved in file order so a team's members arrive where the team
  was written, and deduplicated by user - somebody named directly and through a team is one person
  asked once. A team the forge has never heard of resolves to nobody, exactly like an unknown
  handle. The author is excluded even when the naming is indirect: being on the team does not put a
  request for your own change in your own queue, and the e2e's team deliberately includes the
  author to hold that.

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
- [x] Computed in the background rather than on page load. It is computed in the view for now; the
      cache makes that one merge per pair of commits rather than one per visit, but it still means
      the first visitor after a push waits for it. This needs the queue (phase 5 prerequisites).

  It needed less queue than it thought: the push is the moment the cached answer goes stale, and
  the push already runs `ProcessPushJob`. The job's cheap half marked the state unknown; it now
  also recomputes, after the head shas are brought current, so the answer lands keyed to the new
  head and the page's own call finds the cache warm. Nothing about the view changed - a job
  failure costs only the head start, and the view recomputes on demand exactly as before.
  `tests/e2e/background-mergeability.test.ts` pushes, runs the job, and asserts the row already
  holds `clean` keyed to the new head.
- [x] Merge strategies: merge commit, squash, rebase. Each configurable per repository, with a
      default. Three boolean columns rather than a parsed list, because a list can be malformed and
      a malformed merge setting is a branch rule that quietly stops applying - `required_checks` on
      `protected_branches` needs a whole paragraph in the merge action about what a corrupt value
      means, and a column per strategy needs none.

  A row written before the columns existed reads as allowing everything. Reading a null as "not
  allowed" would have stopped every merge in every repository on the day the migration ran, which is
  the worst possible moment for a new setting to be strict.

  The default is deliberately *not* narrowed to what is allowed. A default that is not allowed is a
  misconfiguration, and quietly substituting a different strategy is how somebody squashes a branch
  they meant to rebase; it is refused with a sentence instead.

- [x] `MergePullRequestAction.ts` enforcing protected branch rules: required approvals, required
      checks, no changes requested outstanding, conversation resolution. Every reason is collected
      and returned together rather than the first one found - a contributor who fixes the conflict
      only to be told they also need an approval has been sent round the loop twice for no reason.
- [x] Commit message templates for squash and merge, editable at merge time. The caller's words win
      over the template: somebody editing a squash message is writing the only commit message that
      change will ever have, and a template that overrode it would make the field a lie.
- [x] Auto-merge: merge as soon as requirements are met. Needs the queue, because "as soon as" means
      something has to notice a check reporting or an approval landing (phase 5 prerequisites).

  "As soon as" turned out to mean "at the next event that could have satisfied the requirements",
  which is exactly when the requirements change - so there is nothing to poll and no queue to wait
  for. Arming stores the strategy and who asked on the pull request, and `attemptAutoMerge` runs as
  a tail on every such event: a review landing, a thread resolving, a push arriving (head or base),
  mergeability refreshing. When the checks API lands (phase 9), its report action calls the same
  function.

  The attempt *is* `MergePullRequestAction`, invoked as the arming user with a synthesized request:
  that action owns every rule, and a second path through merging would be a second place for one to
  quietly stop being right. A refused attempt is an ordinary outcome and the arm stays armed; two
  events attempting at once both end in the guarded `update-ref`, so exactly one lands. Arming with
  a strategy the repository disallows is refused at arm time - an arm that can never fire is a
  promise the product knows it will break. Arming a pull request whose requirements are already met
  merges it now.

  Building it found a real one: `findRepositoryByPath` never selected the merge-settings columns,
  so `allowedStrategies`, `defaultStrategy` and `delete_branch_on_merge` all read `undefined` in
  the merge action - permissive by the written-before-the-columns rule - and the per-repository
  strategy restrictions and delete-on-merge were configurable and silently inert. The columns ride
  the row now, and the auto-merge e2e holds the refusal.
- [x] Delete the head branch on merge, optionally. Off by default, because deleting somebody's
      branch is not recoverable through the interface and a repository that starts doing it because
      a default changed is one that lost work nobody asked it to lose. Refused while any other open
      pull request is built on that branch, which would otherwise break theirs and take the branch
      they are still working from.
- [x] Offer to restore a deleted head branch. The sha is on the merged pull request, so this is a
      button and a ref write; what it needs is somewhere to put the button.

  The button lives in a "Head branch" panel in the conversation page's sidebar, offered on merged
  pull requests whose branch is gone, to readers with `repository:push` - the ability the endpoint
  checks, because creating a branch is a push whatever button did it. The write is a *guarded*
  create (`update-ref` with the all-zeroes old value, git's spelling of "must not exist"): between
  the check and the write somebody may push a new branch under the old name, and overwriting theirs
  with an old sha would be losing their work to a button. A commit pruned since the merge is
  reported as what it is. `tests/e2e/restore-branch.test.ts` asks the route with real credentials
  and asks git where the ref ended up - including that a refused restore wrote nothing.
- [x] Tests: every strategy, every protection rule, and a race where two pull requests merge at once.
      The strategies and the rules are covered in `tests/unit/merge.test.ts` and
      `tests/unit/merge-apply.test.ts`; the race is not, and it is the one that needs two processes.

  The race is in `merge-apply.test.ts` now, and it genuinely is two processes: `performMerge`
  shells out, so the contenders are git processes serialized by the ref lock on disk, not by
  anything in the test's runtime. Two merges race from the same observed base - a squash against a
  rebase, so both strategies' paths to `update-ref` are in it - and what is held is not who wins,
  because either may, but that exactly one does, that the ref is exactly where the winner put it,
  and that the loser was refused for the stated reason with nothing written.

## Stacked pull requests

The differentiator. Nothing else in this space handles it well.

Most of this was built and left unticked, which is the failure this file opens by warning about. The
boxes below were audited against the code and against a new end-to-end test rather than ticked from
memory.

- [x] `stack_parent_id` makes a pull request depend on another, and it is filled in *automatically*:
      a pull request opened against another open pull request's branch is part of a stack, and
      `OpenPullRequestAction` says so. Nobody declares it.
- [x] A stacked pull request diffs against its parent's head, so it shows only its own changes.

  This falls out of the base being the parent's branch rather than from anything that states it, so
  nothing in the code asserted it and it could have stopped being true silently.
  `tests/e2e/stacked-diff.test.ts` builds a real three-deep stack, opens all three through the real
  action, and checks the middle one carries one file. It also checks what the same head diffed
  against the *default* branch would carry - all three - which is what makes the first assertion
  measure something rather than pass by coincidence.

  It matters more than it sounds: a middle pull request that showed its parent's changes would make
  the reviewer read the same code twice, and a stack would be worse than one large branch rather
  than better.
- [x] The interface shows the whole stack, with each entry's position and state (`StackNav.stx`,
      `positionIn`, `stackSummary`).
- [x] Merging a parent automatically retargets its children to the parent's base. A child somebody
      has already pointed elsewhere keeps its base and only loses the stack link, so retargeting
      never moves a branch out from under a decision somebody made by hand.
- [x] Merge the whole stack in order in one action, stopping cleanly if one fails. Landing is
      contiguous from the bottom by definition - merging the third without the second would take the
      second's commits with it - so `MergeStackAction` lands the longest ready run and reports how
      far it got. A partial land is a correct outcome, not a failure.
- [ ] Detect a stack from branch topology *on push*, before a pull request exists, and offer it.
      Detection at open time is done and is most of the value; this is the half that would let
      somebody push three branches and be offered the stack rather than opening three pull requests
      in the right order.
- [x] Tests: a three-deep stack, merging out of order, and a parent closed without merging. All
      three in `tests/unit/stack.test.ts` - "the top being ready does not let it jump the queue" is
      the out-of-order case, and "a closed parent orphans its child" is the third.

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

- [x] Advance "last looked" explicitly, so a reviewer can say they have caught up without submitting
      a verdict. It is currently the later of their last review and their last viewed-file mark,
      which is right for the common case and has no way to say "I have read this round".

  A third record: `ReviewCheckpoint`, one row per reviewer per pull request, upserted in place -
  the history of catch-ups is not worth keeping, because the only question is "where did this
  reader get to" and only the latest answer is the answer. `lastSeenHead` takes the latest of all
  three, so a review submitted after a checkpoint outranks it. The button is in the conversation
  page's Conversations panel, for signed-in readers who may review, and the endpoint records the
  head *as it is then* rather than one the client names - a stale page must not mark a round read
  that its reader never saw offered.

  The e2e caught the bug worth writing down: the upsert's first draft stamped rows with
  `CURRENT_TIMESTAMP`, which writes the database server's *local* clock into these naive timestamp
  columns while the application writes UTC ISO strings everywhere - so a checkpoint outranked
  reviews submitted up to eight hours after it, for as many hours as the server sits east of
  Greenwich. The time is bound as a parameter now, and worth checking for anywhere else raw SQL
  writes a clock.
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
- [x] **The review queue is the home screen.** `/reviews`: what is waiting on you and what you are
      waiting on, ordered by how long it has been waiting and how blocked the author is. First in the
      navigation, because it is the question somebody opens a forge to answer.

  Rendered entirely on the server with no client script. A queue is a list of links; it does not need
  a runtime, and a page that reads its own state on every load can never show a stale count.

  The ordering is the feature, so it is a pure function over values and it is written down. Age,
  weighted three ways and no more, because every extra term is another thing a reader cannot hold in
  their head when the order surprises them: a **draft sorts below everything** whatever its age,
  since somebody who has not marked their work ready has not asked; **being the only reviewer counts
  double**, because nobody else can unblock it; and **an approval already in halves it**, because the
  pull request can move without you.

  Every row says why it is where it is - `2d, only you`, `5h, 3 asked` - because a queue that cannot
  explain its own order is one people route around and go back to reading email. Ties break on the
  pull request's own number, so two reloads a second apart produce the same list.

  The two halves are two queries rather than one clever union: "who was asked and has not answered"
  and "whose pull requests have an unanswered request" are genuinely different questions, and one
  statement for both is how one of them silently stops being right. `tests/e2e/review-queue.test.ts`
  covers the rule most likely to be got wrong - the reviewer row is *kept* when a review lands, so a
  read that forgets `responded_at IS NULL` shows a queue that never empties.

- [x] A count on the navigation item, so the answer is visible without opening the page.

  The query is cheap - one indexed `COUNT` - and the decision it needs is not about staleness, it is
  about where it runs. The badge belongs in `layouts/app.stx`, which has no `<script server>` and is
  used by every page in the product; an stx server script that throws renders its page with every
  variable undefined and says nothing, so putting the first one into the shared layout means one
  mistake blanks the whole application rather than one screen. Worth doing, worth doing deliberately,
  and worth a guard that cannot throw.

  The answer to "where it runs" is: not in the layout at all. `ReviewQueueBadge.stx` is a component,
  so the layout carries one tag and no script, and everything the component does sits inside a guard
  that cannot throw - any failure renders no badge, which is what a signed-out reader gets on
  purpose. The count is `outstandingRequestCount` in `queue.ts`, beside the queries it must agree
  with and reading `responded_at IS NULL` the same way; it counts the waiting-on-you half only, and
  excludes drafts, deliberately diverging from the list - the queue can say "not asking yet" beside
  a draft, and a badge has no room for the sentence. Zero renders nothing rather than a `0`: a zero
  on the navigation is the forge saying "nothing needs you" every second of the day, and silence
  says it better. `tests/e2e/review-queue-badge.test.ts` asks the rendered page, not the function,
  for each kind of reader.
- [x] Suggested reviewers from who actually changed these lines, weighted by recency, not only from
      `CODEOWNERS`. Include current review load, so the suggestion does not always name the same
      person.

  `CODEOWNERS` answers "who is responsible", which is a policy; this answers "who knows this code",
  which is a fact, and the two disagree often enough to both be worth having. The owner of a
  directory is frequently not the person who wrote the twelve lines somebody just changed.

  Three terms. **Who touched these paths**, from `git log` over the changed paths only - reading the
  repository at large would name the most prolific committer for every pull request, which is a
  suggestion nobody reads twice. **How recently**, halving every ninety days: a curve rather than a
  cliff, because there is no honest date on which somebody stops knowing a file. And **how much is
  already waiting on them**, reciprocally, so it can never reach zero - somebody buried in requests
  is still the right answer when they are the only person who has touched the file. Being busy is a
  reason to prefer somebody else, not a reason to be invisible.

  A suggestion, never a request. `CODEOWNERS` requests automatically because a file in the repository
  said to; this is the forge having an opinion, and an opinion is offered. Requesting from a
  heuristic would fill every queue with guesses, and a queue full of guesses is one people stop
  reading. Every suggestion says why - `3 commits here, last 5d ago, 2 waiting on them` - because a
  name nobody can account for is one people either click without thinking or ignore.

  History is read on the **base**. The head's recent commits are the ones being reviewed, and
  counting them would suggest the author of the change as the reviewer of it.

- [x] Show the suggestions somewhere. The endpoint exists and nothing calls it, which is a feature
      with no interface. It is an endpoint rather than something the conversation page computes
      inline on purpose: it costs a `git log` over the changed paths, and paying that on every render
      of every pull request page to fill a panel most readers will not use is the wrong default.
      Fetched when the reviewer list is opened is the shape it wants.

  A `<details>` panel in the conversation page's sidebar (`SuggestedReviewers.stx`), above the
  Reviews panel: who should look, above who has looked. The `<details>` opens and closes with no
  script; the one script it carries notices the first open - and only the first - and fetches, so
  the `git log` is spent when a reader asks and never at render. Each name carries its reason
  verbatim, and nothing submits anything: a suggestion, never a request, exactly as the item above
  says. Offered to signed-in readers with `pull:review` on open pull requests - an anonymous reader
  cannot ask anybody, and a suggestion on a merged pull request is dead weight. The endpoint answers
  anonymous readers of public repositories more loosely than that gate implies, which is worth a
  look of its own someday.

  `tests/e2e/suggested-reviewers-panel.test.ts` pins the surface the in-process test cannot: the
  endpoint answering a fetch whose only credential is a cookie, and the rendered page carrying the
  panel and its URL but none of the answer - the cost deferred, asserted in markup. Getting it to
  pass surfaced that a page rendered through `route.serve()`'s file routing has no
  `__stxServeContext`, only raw headers, so every view read its readers as strangers there:
  `cookieJarFromHeader` is the shared parse, this page asks whichever pipeline answered, and the
  same fallback is owed to every other view that reads `serveContext?.cookies`.

  And one to know before writing the next client script: stx's client bridge seeds any identifier a
  client script shares with the server scope into the page as a `var`. This page's server scope has
  a `headers` binding holding the request headers, so the panel's first draft - an innocent
  `fetch(url, { headers: { Accept: ... } })` - serialized the reader's session cookie into the HTML.
  The word `headers` in a *client* script is enough. The test now asserts the token is not in the
  page, whatever the next mechanism would be.

- [x] A settings screen for the merge strategies. The columns exist and `MergePullRequestAction`
      honours them, so a repository can be configured through the API and not through the interface.

  The claim about the API was optimistic: `decideSettings` did not read the merge columns either,
  so they are part of the settings rule now - every-strategy-off is a configuration and a default
  the booleans disallow is stored rather than swapped, both quoted from the model. The screen is a
  "Merging" card on the settings page: three strategy checkboxes, the default, and delete-on-merge.
  Each checkbox is preceded by a hidden same-named `false` field because the router keeps the last
  value of a repeated key - without it an unticked box sends nothing, and nothing means "leave it
  alone", a form that could never turn a strategy off. That mechanical fact is pinned by
  `tests/e2e/merge-settings.test.ts`, which sends the form's bodies byte for byte and reads the
  row back, because it is exactly the kind of fact a router upgrade changes without anything else
  failing.
- [x] Reviewer load and staleness visible to maintainers: which requests have gone unanswered, and
      by whom, as information rather than as a leaderboard

  A "Waiting on reviewers" panel on the pull request list, for readers with `repository:settings`.
  "Not a leaderboard" is enforced by the ordering: rows come oldest-wait first, because the request
  that has waited longest is the one to go and ask about, and ordering by count would rank people -
  a table that reads as "who is slowest" gets routed around, and then nobody looks at it at all.
  Each row is a phrase in the queue's own age words (`2 waiting, oldest 3d`; `agePhrase` is shared
  so the two surfaces cannot describe the same wait two ways), the reading rules are the queue's
  and the badge's (`responded_at IS NULL`, open, not draft), and an empty panel renders nothing
  rather than announcing that nothing is stuck. `tests/e2e/reviewer-load.test.ts` holds the
  ordering, the exclusions, the phrase, and the gate.
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
      all without the mouse, and a command palette for everything else.

  Navigation is done. `j` and `k` walk the files, `n` and `p` the threads, `N` and `P` the threads
  still unresolved, and `/` opens the filter. The keys are the ones every forge has trained people
  on, so nobody has to learn ours, and they are ignored while the reader is typing - `n` in a reply
  box is the letter n.

  Unresolved is a separate pair rather than a mode because a second round of review is mostly "what
  did I ask for that has not been answered", and walking every thread to find them means reading
  every one somebody already resolved.

  What is left is the verdict: approve, request changes and submit have no keys because the files
  page has no form to submit them from - that surface has to exist before a shortcut can reach it.
  A command palette waits on there being enough commands to be worth searching.
- [x] Tests: a force-push mid-review keeps the incremental diff correct, and classification does not
      hide a logic change inside a rename. Both are the assertion that would fail on a plausible
      wrong implementation, which is why they are the two written down here.

  `tests/e2e/since-last-look.test.ts` builds a repository, moves the base under the branch, rebases,
  force-pushes, and asserts the file whose proposal did not move is *not* put back in front of the
  reader. Every commit sha on the branch is different by then, so an implementation comparing two
  tips names the whole branch and fails.

  `tests/unit/classify.test.ts` puts one real edit among a run of renames and asserts the hunk
  classifies as logic, not as a rename. That is the one failure this feature can cause: a folded
  hunk is a promise that nothing in it needs reading, and it is made inside a diff the reviewer has
  been told is safe to skim.

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
- [x] The diff renders on the server; the browser gets HTML, not a diff library and a JSON payload.
      The architecture of [phase 14](./14-diff-engine.md), defended on the marketing site, and held
      to by `tests/e2e/review-page.test.ts`, which fetches the page with nothing to run a script and
      asserts the rows, the syntax tokens and the review threads are in the markup.

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
- [x] Automatic rebase of higher layers when a lower one lands, beyond retargeting

  Retargeting moves a child's base; restacking (`restack.ts`) moves its *branch*: the child's own
  commits - the range from the parent's old head, which excludes everything the parent landed -
  replayed onto the merge result, and the child's ref moved there guarded by its old head, so a
  push mid-restack wins and the restack refuses rather than discards. A replay that cannot apply
  leaves the branch alone: a conflict is the one case where a human has to decide what the change
  means now. Squash is the strategy that makes this matter - the parent's original commits never
  reach the base, and an unrestacked child re-shows the parent's work in its own diff forever.

  Two latent bugs surfaced on the way. Retargeting changed `base_branch` and left `base_sha` at the
  parent's old head, and `performMerge` guards its update-ref on the row's `base_sha` - so merging
  *any* retargeted child was refused as "the base moved", because it had, at retarget time, and
  nothing had said so. Both retarget sites now move the sha with the branch. And
  `findRepositoryByPath` never carried the merge-settings columns (written up under auto-merge).

- [x] Merge queue support for stacks

  The queue falls out of composition rather than existing as a thing: arming stack members is
  enqueueing them. An armed child is blocked by its unmerged parent (the merge action's own rule);
  the parent landing retargets, restacks, and attempts the child, whose own arm fires the moment
  its requirements hold - so an approved, armed stack lands bottom-up in order with nobody pressing
  merge, and a member that is not ready simply holds its layer and everything above it.
  `tests/e2e/stack-restack.test.ts` holds the whole arc: the armed child waiting behind the parent,
  the approval cascade landing both in order, the child's branch genuinely rebased before it
  merged, and its commit on the base exactly once.

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
