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

  Issues, their comments, labels, milestones and state. A pull request appears
  in GitHub's issues endpoint too, and importing it there as well would produce
  a second row with the same number - `onlyIssues` is what stops that, and the
  fixture includes one to prove it does.

  **The comments are the reason to migrate at all.** A repository whose issues
  arrived without them has kept the questions and lost every answer, which is a
  worse artefact than a link to the old forge. They are fetched as one
  collection rather than per issue: two thousand issues would otherwise be two
  thousand requests against an hourly limit.

  GitHub files comments on pull requests under `/issues/comments` as well, and
  here those are separate tables - so the number is looked up in both. Attached
  to the wrong one, a comment appears on an unrelated conversation that happens
  to share a number, which is the shape of mistake nobody reviews for because it
  looks like ordinary data.

  `issue_comments` gained an `external_id`, because a comment carries no other
  stable identity: two people can write the same words on the same issue in the
  same minute, so matching on body and time would collapse them, and matching on
  nothing duplicates every comment a resumed import re-reads. `review_comments`
  has had the column since it was written and it is the same argument.

  Milestones are keyed on their title within the repository - which is what an
  issue references, what a person searches for, and what GitHub itself treats as
  the identity in every url it prints. Closed ones are imported too: that is
  where most of a repository's history is filed.
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
- [x] Releases and their assets

  **The assets are the part that matters and the part that is easy to skip.** A
  release without its binary is a tag with a paragraph attached: every link in a
  changelog, every install script and every "download the previous version"
  request points at a file that is no longer anywhere.

  Each one is downloaded, checksummed and stored the way an upload through the
  interface stores it, so there is no import-only path to keep working. A single
  asset that fails is recorded and skipped rather than fatal - a release with
  nine of its ten is worth having, and a migration that stopped on a file
  somebody deleted upstream years ago would never finish.

  Keyed on the tag, which is a release's identity in git, in a changelog and in
  every url pointing at it. The framework's own columns on this table are filled
  in rather than left null: `version` is not null, and an imported release that
  skipped it would be a row the dashboard renders differently from one published
  here.
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

- [x] Gitea and Forgejo, which share an API shape

  One importer, because they answer GitHub's shape closely enough to share the
  client - and `app/Actions/Import/forges.ts` for the handful of places they do
  not. **An importer written as though they were identical works against
  whatever fixture it was built with and then loses data on a real instance**,
  which is the worst outcome available because the migration looks like it
  worked.

  What actually differs, each asserted rather than assumed:

  - **A pull request is numbered `index`, not `number`.** This one is silent:
    the mapper shared with the mirror knows only `number`, so a Gitea pull
    request arrived with no number and was dropped entirely. The first version
    of this passed its own tests and imported nothing. It is normalised at the
    boundary now, translated once rather than branched on at every use.
  - **The API is under `/api/v1`**, which is not the address people paste -
    they paste the web interface, because that is the address they know. Both
    spellings resolve, and pasting the API address does not double the prefix.
  - **A token is `token abc`, not `Bearer abc`.** Gitea answers a wrong scheme
    as *unauthenticated* rather than rejecting it, so a private repository
    imports as empty and reports success.
  - **There is no repository-wide review comment list**, so reviews cost a
    request per pull request. A different cost model rather than a different
    field name.

  Forgejo is a fork of Gitea with a deliberately compatible API, so it is one
  entry rather than two. Tested against a fixture that answers the Gitea shape
  and refuses any request that arrives without the prefix - if the prefix were
  assumed rather than applied, the test fails rather than passing quietly.
- [x] GitLab

  **An adapter rather than parameters**, because GitLab is not a variation on
  GitHub's API - it is a different vocabulary for the same ideas. Gitea needed
  four settings; GitLab shares none of the paths, so `gitlab-client.ts`
  translates and nothing after it knows which forge the data came from.

  | Here | GitHub | GitLab |
  |---|---|---|
  | the number in `#123` | `number` | `iid` |
  | a proposed change | pull request | merge request |
  | a comment | comment | note |
  | a review thread | review comment | discussion |
  | open | `open` | `opened` |
  | who wrote it | `user.login` | `author.username` |
  | a repository | `owner/name` | a project by encoded path |

  **`iid` is the one that would do the most damage.** Every GitLab object has
  both: `id` is unique across the instance, `iid` is the number in the URL and
  in `#123`. Reading `id` gives a repository whose issues are numbered 4,318 and
  4,319 where the highest was 12, and every cross reference in its own history
  breaks quietly, because the numbers are still plausible.

  Four more that are silent when wrong:

  - **A merged merge request is `merged`, not closed.** GitLab has three states
    where GitHub has two and a timestamp, and recording a merge as a close loses
    the single thing anybody opens a closed pull request to find out.
  - **A review comment on a deleted line has only `old_line`.** Reading
    `new_line` gives null - an anchorless comment, which is the exact loss this
    importer exists to prevent.
  - **A note with no `position` is not a review comment.** It is an ordinary
    comment on the merge request, and filing it as a review comment puts a
    general remark on an arbitrary line of an arbitrary file.
  - **System notes are dropped.** "Changed the milestone" and "mentioned in
    commit abc" are notes; imported, they bury every real comment under machine
    chatter that reads as though a person wrote it.

  The project path is one encoded segment - `acme%2Fapi`, and subgroups have
  more slashes - so the fixture refuses an unencoded path loudly rather than
  answering it. `/projects/acme/api` is a different endpoint that answers 404,
  which looks like the repository does not exist.

  The job's client is typed as an `ImportSource` rather than `any`, so a client
  that stops satisfying the surface is a compile error instead of a stage that
  quietly returns nothing.
- [x] Plain git URL import, with no metadata, for everything else

  `buddy import:git <url>`. The escape hatch that makes the other importers
  optional: somebody moving off a forge nobody has written an importer for -
  Bitbucket, cgit, a bare repository on a server being decommissioned - gets
  their history in today, with one command.

  Synchronous rather than queued, because there is one step and no rate limit,
  and a job would add a worker dependency and a progress row to something whose
  whole duration is one `git clone`.

  It says what it did not bring. An operator who ran this expecting a full
  migration and found empty issue lists would reasonably conclude the product is
  broken, so the last line of output names what a git URL does not carry. The
  default branch is read from the clone rather than assumed: a repository whose
  branch is `master` or `trunk` and is recorded as `main` shows an empty file
  list on its own front page.

## Mirroring

Moved to its own phase: [13 - Mirroring](./13-mirroring.md).

Mirroring outgrew this file. Import assumes you have decided to leave GitHub; mirroring assumes you
have decided nothing, which makes it the way most people will first see this forge rather than a
step in a migration.

## Exporting

- [x] Full export of a repository and its metadata as an archive

  `buddy export:repository owner/name`. A directory rather than an archive:
  tarring it is one command somebody already knows, and a directory can be
  inspected, diffed and partially copied, which is what people actually do with
  an export before they trust it.

  `git/` is a real bare repository - `git clone` against it works - so the most
  important half needs no tooling at all to read.
- [x] Documented, stable export format, so leaving is possible. A forge that is hard to leave is a
      forge people are right to distrust.

  **Nothing is referenced by a local id.** A comment names its issue by
  `number`, because a number is what the repository's own history refers to and
  an id is a fact about our database that means nothing anywhere else. People
  are handles; an imported author nobody claimed keeps the name they had at the
  source; and where there is neither, the field is `null` rather than
  `"unknown"`, because filling it would be inventing a person.

  The manifest carries a `format` version. A format nobody can date is a format
  nobody can write a reader for two years from now.

  Review anchors survive the round trip - file, line and side - which would be
  perverse to lose on the way out given the importer exists to keep them on the
  way in. The writer lives in `app/Actions/Import/export.ts` rather than in the
  command, so the test runs the real thing: an export whose only caller is a CLI
  entry point is an export nothing exercises, and this is the feature whose
  entire purpose is being trustworthy.
