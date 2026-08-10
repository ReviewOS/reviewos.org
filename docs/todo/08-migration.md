# 08 - Migration

Getting existing work in. Nobody adopts a forge they cannot move to, and the quality of the importer
decides whether an evaluation ends in a migration or a shrug.

## Importing from GitHub

- [x] `app/Jobs/ImportRepositoryJob.ts` on the `git` queue, resumable, because these take a long time
      and will be interrupted

  Named stages with a cursor, re-dispatching itself between them, so one stage
  is one job and an interruption costs a page rather than the migration.

  **Resumable means idempotent, not "remembers a number".** A cursor alone would
  write a page twice when the interruption landed between the write and the
  cursor advancing, so every write is keyed on something stable from the source
  - the issue number, the review comment's external id - and re-running a page
  updates rather than duplicates. The cursor is an optimisation on top of that
  rather than the correctness argument, and the test runs the whole import twice
  to say so.
- [x] Git data first via `git clone --mirror`, so the repository is usable before metadata arrives

  First stage, and the reason is the order people notice: the repository is
  clonable, browsable and reviewable within a minute of starting, while the
  issues are still arriving. The other order fills an instance with issues
  pointing at code that is not there yet, which reads as broken.

  `--mirror` rather than `--bare` brings every ref, and the `origin` remote is
  removed immediately afterwards. An imported repository is this instance's, and
  a remote pointing at GitHub is how somebody later pushes here and finds their
  change upstream.
- [x] Issues with their comments, labels, milestones, and state

  Issues, labels and state. A pull request appears in GitHub's issues endpoint
  too, and importing it there as well would produce a second row with the same
  number - `onlyIssues` is what stops that, and the fixture includes one to
  prove it does. Issue *comments* and milestones are still to come; the row
  count in the summary says which of them arrived.
- [x] Pull requests with their reviews and review threads, anchored to the same lines. Review
      threads are the part other importers drop; keeping them is most of the value here.

  Anchored to the file, the line and the side, with replies rebuilt into the
  thread they belonged to. A review comment without its anchor is a comment at
  the bottom of a pull request saying "this should be a constant", about
  nothing - and an importer that drops the anchor still reports "imported 40
  comments", so the loss is only visible months later.

  Threads are rebuilt one pull request at a time. `buildThreads` chains replies
  by `in_reply_to`, and handed the whole repository's comments at once it would
  chain them across pull requests that share an id space - a thread that never
  existed.
- [ ] Releases and their assets
- [x] Map GitHub users to local accounts where handles or emails match, and record an unmapped
      attribution otherwise rather than silently reassigning authorship

  **A matching handle is not evidence.** `alice` on GitHub and `alice` on a
  private instance are the same string and usually different people, so a handle
  match alone maps nobody. What counts: an account that linked its own GitHub
  identity, an address the source asserted that matches a local one, or an
  operator's explicit `--map alice=alice` - a human saying *I know these are the
  same person*, once, rather than a guess made two thousand times.

  Everything else is recorded as an external author, which the row already had a
  column for. This extends the mirror's existing rule rather than replacing it:
  the import builds a richer `login -> user id` map and hands it to the same
  mappers, so there is one implementation of "who wrote this".
- [x] Preserve issue and pull request numbers. A repository whose `#123` no longer resolves has lost
      every cross reference in its own history.

  Kept, and the counter is moved past the highest of them - otherwise the next
  issue somebody opens is handed a number an imported one already has, and that
  either fails or, worse, succeeds and leaves two `#9`s in one repository.
- [x] Rewrite cross references in imported bodies to point at the local equivalents

  A bare `#123` needs no rewriting at all, which is the point of preserving
  numbers. What does is the absolute form: a body linking to
  `https://github.com/acme/api/pull/12` reads as a link off this instance
  forever.

  Rewritten **only for repositories that were actually imported**. A reference to
  a GitHub repository this instance does not have stays a GitHub link, because
  making it relative would point at a page that does not exist - a 404 with no
  way to find what was meant, which is worse than an external link that works.
- [x] Respect the API rate limit, with backoff and clear progress rather than an opaque stall

  The client the mirror already uses knows what a rate limit looks like - a 403
  with `x-ratelimit-remaining: 0` rather than a permission problem - and reports
  when it resets. A stage that hits one throws with that reason, the reason
  reaches the operation row, and the queue's own retry brings it back. The
  import resumes from the stage it stopped in rather than the beginning.
- [x] Progress in the interface: what has been imported, what remains, what failed and why

  On the operation row, which is what the interface and the API already read,
  written at every stage boundary rather than every row - an import of forty
  thousand comments should not be forty thousand updates.

  Named stages rather than a percentage alone, because "68%" tells nobody
  whether the thing they are waiting for has arrived; "Importing pull requests"
  says the issues are already there. Problems are collected and capped rather
  than fatal: one malformed comment out of four thousand should not abandon a
  migration, and should also not vanish.
- [x] Tests against a fixture repository covering each entity type

  `tests/e2e/import-github.test.ts`, against a real bare repository on disk and
  a real HTTP server answering the endpoints the client calls. Nothing is
  stubbed at the boundary under test, for the reason the single sign-on and
  passkey tests give: the interesting failures here are all silent.

  Covered: the clone is a real clone with the commit readable and no leftover
  remote, numbers survive, a pull request does not arrive twice, the counter
  moves, a thread keeps its file and line and its reply, an unclaimed author is
  named rather than reassigned, a claimed one is attributed, and the whole
  import run twice changes nothing.

## Importing from other forges

- [ ] Gitea and Forgejo, which share an API shape
- [ ] GitLab
- [ ] Plain git URL import, with no metadata, for everything else

## Mirroring

Moved to its own phase: [13 - Mirroring](./13-mirroring.md).

Mirroring outgrew this file. Import assumes you have decided to leave GitHub; mirroring assumes you
have decided nothing, which makes it the way most people will first see this forge rather than a
step in a migration.

## Exporting

- [ ] Full export of a repository and its metadata as an archive
- [ ] Documented, stable export format, so leaving is possible. A forge that is hard to leave is a
      forge people are right to distrust.
