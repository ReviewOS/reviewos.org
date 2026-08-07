# 02 - Git hosting

Actually hosting git: repositories on disk, the wire protocol, and reading code in a browser.

The rule for this whole phase: **the system git binary does the git work.** It is a declared pantry
dependency. Do not add a git library, and do not reimplement packfile handling in TypeScript. Every
path that touches a repository on disk goes through `app/Actions/Git/`, so the storage layout stays
known to exactly one place.

## Storage

- [x] Bare repositories at `storage/repos/{owner}/{repository}.git`
- [x] One helper that resolves an owner and repository name to an absolute path, rejecting `..`,
      absolute paths, and anything that escapes the root (`app/Actions/Git/storage.ts`). Every other
      caller uses it, and the resolved path is checked against the root a second time, so if the
      allowlist and the resolution ever disagree the allowlist is what is wrong.
- [x] `git init --bare` on creation, with `core.hooksPath` pointed at a shared hook directory. One
      shared directory rather than a copy of the scripts in every repository: copies drift, and the
      repositories nobody pushes to would keep whichever version they were created with, which is
      exactly where a silent failure goes unnoticed longest. `buddy git:hooks` writes them and
      repoints every repository, which is the deploy step after an upgrade.
- [x] Repository size accounting, updated after receives and after a fork. From
      `git count-objects -v` rather than `du`: forks share their objects through hardlinks, so `du`
      counts the same bytes once per fork and a hundred forks look like a hundred times the disk
- [x] Deleting a repository moves it aside with a timestamp rather than unlinking, so an accidental
      delete is recoverable for a retention window. The database work happens first: a failure then
      is a delete that did not happen, where the other order leaves a repository that is gone from
      disk and still listed
- [x] A retention sweep that removes `storage/repos-deleted/` entries older than the window, at
      thirty days - longer than a holiday, which is the case that matters. A directory whose name
      the sweep cannot read is **never** removed: the bytes in there are the last copy, so anything
      unexpected is a reason for a person to look rather than a reason to delete

## Models

- [x] `app/Models/Repository.ts`: polymorphic `owner` (user or organization), `name`, `slug`,
      `description`, `visibility` (public, private, internal), `default_branch`, `is_fork`,
      `parent_id`, `is_archived`, `is_template`, `size_kb`, `stars_count`, `forks_count`,
      `open_issues_count`, `pushed_at`
- [x] Unique constraint on `(owner_type, owner_id, name)`, and on `(repository_id, user_id)` for
      stars, watches and collaborators
- [x] Counter columns are denormalized on purpose; every writer updates them in the same transaction
      as the row it counts. They are recomputed rather than incremented - see
      `app/Actions/Repo/counters.ts` for why an increment nobody can verify is an increment that has
      been wrong since it was written. What keeps this true is `tests/unit/repo-counters.test.ts`,
      which reads the action and job sources, finds the writes that change something counted, and
      insists the same file recounts it: a denormalized counter does not go wrong in the arithmetic,
      it goes wrong at the eighth call site somebody adds without knowing the other seven exist.
      **It found one on its first run.** `MirrorMetadataSyncJob` imported a mirror's issues -
      hundreds at once, and the upstream's closes between runs - and never recounted, so a mirrored
      repository read `0 open issues` however many it had. Nobody files that as a bug, because it
      looks exactly like a repository with no issues
- [x] `app/Models/RepoCollaborator.ts`: `repository_id`, `user_id`, `permission`
- [x] `app/Models/Star.ts`, `app/Models/Watch.ts` with a `subscription` level (all, participating,
      ignore)
- [x] `app/Models/ProtectedBranch.ts`: pattern, required approvals, dismiss stale reviews, required
      status checks, restrict who can push, allow force push, allow deletion
- [x] `app/Models/RepoTopic.ts`, normalised to lower case with spaces as dashes so `TypeScript` and
      `typescript` are one topic. A row per topic rather than a list on the repository, because the
      query that justifies a topic runs the other way - every repository tagged `rust` - and a
      comma-joined string cannot be indexed for it
- [x] `app/Models/Release.ts` and `app/Models/ReleaseAsset.ts`, **published from the framework
      default** (`buddy publish:model Release`) and extended rather than written fresh. A userland
      model replaces a framework default instead of merging with it, so a hand-written one emitted
      `ALTER TABLE releases DROP COLUMN version` while the framework's own dashboard actions went on
      selecting it. Every framework column is still there, and where the two mean the same thing the
      framework's is used rather than duplicated: `version` is the tag, `status` is draft or
      published so there is no second flag to disagree with it, `notes` is the body, `author` sits
      beside `user_id`. Only `type` changed, from required to optional - a git tag is not a decision
      about major, minor or patch
- [x] Fixed upstream so nobody else finds it the hard way: `buddy generate:migrations` now refuses to
      write a migration that drops columns from a table a userland model took over from a framework
      default, naming the columns and pointing at `buddy publish:model`
      (`storage/framework/core/database/src/shadowed-models.ts` in the Stacks checkout).
      `STACKS_ALLOW_SHADOW_DROPS=1` for somebody who means it
- [x] A release is a tag plus notes, so the tag has to exist first. Creating it here was the
      alternative and is worse: it makes publishing a release something that changes what a clone
      contains. Deleting a release leaves the tag alone for the same reason
- [x] `target_sha` is recorded at publication rather than resolved on read, because a tag can be
      moved - and a release whose notes describe a commit nobody can name again is worth less than
      no release
- [x] "Latest" is the highest version, not the most recently published. Sorting by date is the
      obvious implementation and is wrong in the case that matters: a patch backported to an old
      branch and published today would become the version every install script fetches. Drafts and
      prereleases are never latest, and `v1.10.0` outranks `v1.9.0`
- [x] Uploading and serving release assets. Simpler rules than an issue attachment and deliberately
      stricter: an attachment is often a screenshot somebody wants to see inline, so that module has
      to decide which types are safe to render. A release asset is a compiled artefact somebody
      downloads and runs, so there is no allowlist to get wrong - every asset goes out as an opaque
      download with `nosniff`, whatever it is called. A SHA-256 is recorded on upload and published
      beside the file, because a checksum nobody can see is a checksum nobody can check
- [x] A name is refused rather than replaced when it is already taken on that release: an asset name
      is what an install script fetches, and quietly swapping the bytes under a published name is
      the worst version of that endpoint
- [x] A draft's assets are not downloadable by anybody who cannot see the draft, and answer 404
      rather than 403 - the existence of an unannounced release is exactly what a draft is keeping

## Smart HTTP

- [x] `routes/git.ts`, registered in `app/Routes.ts` with an empty prefix so URLs are
      `/{owner}/{repository}.git/...`
- [x] `GET /{owner}/{repository}.git/info/refs?service=git-upload-pack` (clone and fetch discovery)
- [x] `POST /{owner}/{repository}.git/git-upload-pack`
- [x] `POST /{owner}/{repository}.git/git-receive-pack`
- [x] Stream request and response bodies. Buffering a packfile is how this breaks on a real
      repository, and it will pass every test written against a small one.
- [x] **Name the repository as the service's own argument, never `.`.** `upload-pack` and
      `receive-pack` take the repository positionally and resolve it themselves; they do not read
      `--git-dir`. Passing `.` made every request operate on the server process's working directory,
      which is the application's own checkout - so a clone of any URL served the forge's source, a
      clone of a *private* repository served it too (the permission check passes on the repository
      that was asked for, and a different one is handed over), and a push wrote its refs into the
      application's repository. Nothing about it looked wrong: the protocol is spoken correctly,
      `git clone` succeeds and checks out a real tree, `git push` reports a new branch. Found by
      asking not "did the clone work" but "which repository did it clone".
- [x] HTTP basic auth: username plus access token. Password login over git is not accepted.
      This authenticated against a `personal_access_tokens` table that no migration ever created, so
      every authenticated git request failed on a missing relation. It now goes through the access
      tokens from [phase 1](./01-foundation.md#access-tokens), and the token's own grants decide
      the answer: a read-only token belonging to a maintainer cannot push, and a token scoped to two
      repositories cannot touch a third. The username is not checked, because the token already
      names its owner and treating it as meaningful would fail a correct token for a cosmetic
      reason.
- [x] Anonymous read for public repositories; everything else authenticates. Verified against a
      real client: a public repository clones anonymously, a private one answers 404 rather than 403
      so its existence is not confirmed, a read-only token can fetch and is refused a push, and an
      anonymous push is refused. Worth knowing when testing this by hand - `git` will silently reuse
      a credential from the system keychain, so an "anonymous" push that succeeds may not be
      anonymous. `-c credential.helper=` is what makes the test mean anything.
- [x] Correct content types and the `no-cache` headers git expects. git caches aggressively
      otherwise, and a stale ref advertisement makes a fetch quietly miss commits.
- [x] Tests: the argument rule above, checked the way the bug would have been caught - run the real
      command from inside a *different* repository and assert the answer belongs to the one that was
      named. Both directions, so it cannot pass by accident, plus the old behaviour pinned as a
      demonstration of why it was invisible.
- [x] Verified by hand against a live server: shallow clone, full clone, incremental fetch, push,
      and the hook chain firing through the HTTP path (`pushed_at` moves, which is the end-to-end
      proof that the push reached the application).
- [x] The same as an automated end-to-end test (`tests/e2e/git-http.test.ts`). It boots the router
      on an ephemeral port, creates a repository behind a row, and drives the real `git` client
      through clone, push and fetch - plus the JSON API on the same server. It skips itself, loudly,
      without a database, and CI now has Postgres so it does not skip there. Two things it cost:
      the git driver has to be **async**, because a synchronous child blocks the very event loop
      the in-process server answers on and `git clone` then waits sixty seconds for a response
      nobody can write; and the run's hooks go in a directory of its own, because installing into
      the shared one repoints every repository on the machine at a server that stops existing when
      the file finishes
- [x] A repository large enough that streaming matters, as a test rather than by inspection. Every
      other test in that file would pass against a server that read the whole pack into memory and
      then wrote it, because the fixture is three files; the failure that matters appears on
      somebody's real repository, where buffering means one clone holds hundreds of megabytes and
      ten concurrent clones take the process down. So it pushes and clones ~7.5 MB of random
      content - random so nothing delta-compresses the question away - checks it comes back byte
      for byte through `fsck` and a full file comparison, and then reads the wire directly, because
      `git clone` cannot say *how* the bytes arrived. Two things separate streaming from buffering
      and both are asserted: the response declares no `Content-Length`, since a server that knows
      the length has already built the whole thing, and the first bytes arrive well before the last
      rather than everything landing at once at the end

- [x] **`bun test` walked the whole project looking for test files**, `pantry/` included - a package
      tree of hundreds of thousands of files. It follows the symlinks it finds, and once a few
      hundred are open the process is out of file descriptors: the next `spawn` fails `EBADF`, and
      every test that shells out to git fails with it. Thirty-five of them did, in code nothing had
      touched. Reproduced down to **one directory of 800 symlinks anywhere under the project root**,
      needing no import by anything, and fixed by `root = "tests"` in `bunfig.toml` - the tests are
      in `tests/`, and a test runner has no business reading a dependency tree. `bun run` was never
      affected, because it resolves modules rather than scanning for files, which is why the
      application worked while the suite did not

## Receiving a push

- [x] Post-receive hook posts ref updates back to the application. A hook rather than diffing the
      refs either side of `receive-pack`, which is simpler and wrong twice: two pushes to one
      repository interleave, and the answer would only exist for pushes arriving over HTTP. git
      hands a hook the exact updates, and it fires for a push over SSH and for one made on the
      server by hand. It posts to loopback with a shared secret, and the secret gets the request
      *heard* and nothing more - every ref line is re-parsed and shape-checked, and the repository
      is resolved from its path on disk rather than from a name in the body.
- [x] `app/Jobs/ProcessPushJob.ts` on the `git` queue, doing the work asynchronously. The hook runs
      inside `git push` with somebody standing at a prompt, so nothing that walks commits belongs
      in it:
  - [x] Update `pushed_at` and the default branch when it moves. The default branch is only ever
        *adopted* on the first push into an empty repository, where the row says `main` and the
        pusher pushed `master`. Any other time, a push that could repoint it is a push that can
        change what everybody sees when they open the repository.
  - [x] Refresh open pull requests whose head branch changed: the head sha is brought up to date
        and the mergeable state is marked unknown. Recomputing mergeability needs a merge
        simulation and stays where it was; what matters here is that nothing shows a stale "no
        conflicts" against a branch that has moved, because a wrong green is worse than no green.
  - [x] Close issues referenced by closing keywords in the pushed commits, on the same terms a
        merge closes one: this repository only, issues only. No actor is recorded - a commit's
        author is free text that anybody can set, and attributing a close to a local account on
        the strength of one would put words in somebody's mouth.
  - [x] Emit `push:received` for webhooks, notifications, and the activity feed
  - [ ] Queue a search reindex. Waiting on phase 6: there is no index to reindex yet.
- [x] Enforce protected branch rules at receive time, rejecting the push with a message git shows
      the user. A *pre*-receive hook, because receive time is the only moment where refusing is
      worth anything: once the ref is written the dropped commits are unreachable and everybody who
      fetches has the rewritten history. Whether a push is a force push is asked of git rather than
      of the client - `--force` is a flag somebody chose to send, dropping history is what actually
      happened. The hook fails *open*: an unreachable application allows the push, because branch
      protection is a guard rail against a mistake and a forge that stops accepting pushes when its
      web process restarts is a forge people work around.
- [x] Tests: force push to a protected branch is rejected, and a push that closes an issue does.
      Both against real git, including one that proves git runs the hooks at all - it says nothing
      when it skips a hook it cannot execute, so a hook that never runs and a hook that always
      allows are indistinguishable from outside.

## Push protection

Scanning for a leaked credential after the push has landed is a cleanup procedure, not a defense:
the secret is in the reflog, in every clone, and possibly in a mirror before anyone reads the alert.
Rejecting the push is the only version of this feature that prevents anything, and receive time is
the one moment where rejecting is still possible.

- [x] Scan the incoming pack for credential shapes before accepting it, in that order of certainty.
      The detectors are ordered by how sure they are because the failure that matters is the false
      positive: a miss costs one credential, and a wrong refusal on a test fixture costs the whole
      feature. The entropy heuristic is last and narrowest, and needs a variable name that says what
      the value is, a long value, real entropy, *and* that the value is not one of the placeholders
      every README contains. Entropy is worth measuring rather than assuming: English words run
      together score *above* a real base64 key, which is why the name carries most of the signal.
- [x] Reject with a message git prints legibly, naming the file, the line, and what it looks like -
      with the value redacted, because the finding reaches a terminal, the audit log and possibly a
      support thread, and a message that quotes the whole credential leaks it a second time to help
      with the first.
- [x] A bypass that requires a reason and is recorded in the audit log
      (`git push -o secret-scan=bypass -o reason="..."`). Push options are the channel, which means
      `receive.advertisePushOptions` has to be on or git never transmits them and the documented
      escape silently does nothing. Every refusal says what the override needs, because a refusal
      that does not is the one that turns into "just disable the scanner".
- [x] Patterns are configurable per instance, in `config/push-protection.ts`. A configured pattern
      is compiled once and tried against a pathological input with a time budget: a regular
      expression is a program, and one written carelessly takes exponential time - a scanner that
      hangs is a push that hangs, which is indistinguishable from the forge being down.
- [x] Scan history on demand (`buddy git:scan`), reporting rather than rejecting. There is nothing
      left to refuse: the commits are in every clone and in the reflog. It says so, and says that
      rotating the credential is the step that ends the exposure - removing it from history
      afterwards is tidying up, and rewrites everybody's copy.
- [x] Tests: a known token shape is rejected, ten documented placeholders are not, and the bypass is
      logged. Two things this cost, both of which reported success while doing nothing:
      **the pushed objects are quarantined** - during pre-receive they are in a temporary directory
      that only the hook process can see, so the application cannot read a byte of the push without
      the hook forwarding `GIT_OBJECT_DIRECTORY`, and a scanner built without that finds nothing and
      looks like it works; and **the zero sha is forty hex characters**, so it passes a
      full-sha check and a created branch was scanned as the range `000…000..<new>`, which resolves
      to nothing - the exact case somebody pushing a new branch with a key is in.
- [x] A generated hook that does not parse refuses every push, and nothing inside it can catch that:
      a syntax error happens before its own `try` exists. Both scripts are parsed in a test.

## Browsing

- [x] `app/Actions/Browse/TreeAction.ts` - directory listing at a ref and path
- [x] `app/Actions/Browse/BlobAction.ts` - file contents, with binary detection and a size ceiling
- [x] `app/Actions/Browse/CommitsAction.ts` - history, optionally scoped to a path. Paged by sha
      rather than by offset: history is append-only at the tip, so a push while somebody is on page
      three shifts every commit down by one and an offset then repeats one and skips one
- [x] `app/Actions/Browse/CommitAction.ts` - a single commit with the files it changed. A merge is
      diffed against its first parent, because `diff-tree` on a merge with no options prints nothing
      and a page confidently reporting that a merge changed no files is worse than no page
- [x] `app/Actions/Browse/BranchesAction.ts`, `TagsAction.ts`
- [x] `app/Actions/Browse/BlameAction.ts`, capped at 5000 lines. The porcelain format states each
      commit once and then refers to it by sha, so the parser has to remember - reading each line
      independently leaves every line after the first with no author, which looks like a blank
      column rather than a bug
- [x] `app/Actions/Browse/CompareAction.ts` - two refs, the basis for opening a pull request.
      Diffed from the merge base, never from the base tip
- [x] `app/Actions/Git/RawFileAction.ts` and `ArchiveAction.ts` (zip and tar.gz via `git archive`),
      both streamed. Neither serves a repository's content as its own type: `index.html` returned as
      `text/html` from this origin runs script with this application's cookies, so everything is
      `text/plain` or `application/octet-stream` with `nosniff`, and every archive carries a
      directory prefix so it cannot unpack over whatever directory somebody is standing in
- [x] One place decides whether a read may proceed (`app/Actions/Browse/context.ts`), because there
      are ten of these endpoints and ten chances to forget the visibility check
- [x] Syntax highlighting server-side. The client does not download a highlighter.
- [x] Render README, and markdown files generally, at the tree view. The README goes under the
      listing, the way every forge does it, but only in a directory - inside a file the file is the
      subject. Rendering happens in the view rather than through `@markdown`: the directive runs
      before interpolation, so it would markdown-render the literal `{!! readme.text !!}` token and
      then drop the file's text into the page untouched, which for a mirrored repository means
      whatever HTML its README happens to contain

## Repository management

- [x] `app/Actions/Repo/CreateRepositoryAction.ts` - row and bare repository together, cleaning up
      the row if the disk operation fails
- [x] `app/Actions/Repo/UpdateSettingsAction.ts`, `DeleteRepositoryAction.ts`,
      `TransferRepositoryAction.ts`. No `ArchiveRepositoryAction`: archiving is a flag on the
      settings endpoint, because a rename and an archive share the rule that the row and the
      directory have to end up agreeing, and splitting them is how that gets implemented twice.
      The rules are pure in `app/Actions/Repo/settings.ts` and tested away from the database.
- [x] Archived means readable and frozen everywhere, not only for pushes. `authorizeRepository`
      refuses every ability except reading, settings, delete and transfer, stated as an allowlist
      in `app/Permissions.ts` so an ability added later is frozen by default
- [x] A transfer needs admin on the repository *and* the right to create in the destination, and
      drops the old owner's collaborator grants rather than carrying them into a structure the new
      owner did not choose
- [x] `app/Actions/Repo/ForkRepositoryAction.ts` using `git clone --bare --local`, recorded as a
      fork. `--local` hardlinks the object store, which is what makes forking a large repository
      cheap enough to be the normal way to contribute; the test asserts the link count rather than
      the claim
- [x] `app/Actions/Repo/StarAction.ts`, `WatchAction.ts`. Starring toggles because the page cannot
      know whether the star it drew has been pressed since; watching does not, because it has three
      answers and the middle one is the one people want
- [x] Unique indexes on `(owner_type, owner_id, name)` and on the person-plus-repository pairs, so
      the read-then-write checks in create, fork, rename and transfer have something behind them
- [x] **Cascade the repository foreign keys.** Fifteen tables hang off a repository and every
      constraint was `NO ACTION`, so a delete had to remove the children first, in the right order,
      in every place that deletes - and the place that misses one leaves rows nothing can reach.
      The database now removes them, which also covers the deletes the application never made: a
      manual `DELETE`, a restore, another service sharing the schema. Only the repository relation
      cascades; deleting a *user* deliberately does not take their issues, comments or reviews with
      them, because that is a history other people took part in. Three things had to change:
  - [x] **`bun-query-builder` added a second foreign key instead of replacing the first** (0.2.18).
        A column created inline with `REFERENCES` already carries a constraint the server named
        itself (`x_repository_id_fkey`), and `addForeignKey` added `x_repository_id_fk` beside it.
        A server enforces every constraint it holds, so the migration applied cleanly, the cascade
        was real, and deletes went on failing against the `NO ACTION` next to it - with nothing in
        the output saying so
  - [x] **A declared foreign key column lost its relation's `onDelete`** (0.2.21). Writing
        `repository_id` in `attributes` is the ordinary way to give it a validation rule, and it
        cost the relation its cascade silently: the same model with the same `belongsTo` cascaded
        or did not depending on whether its `_id` column happened to be written down twice
  - [x] **A `belongsTo` could not declare `onDelete` at all** (stacks 0.70.289). The field existed
        on `ForeignKeyConfig` for the explicit attribute-level form, and the generator emitted it
        only for the pivot table of a many-to-many - so the relation every one of these fifteen
        columns comes from had nowhere to say it. Now on `BaseRelation`, documented in
        `stacks-models`
  - [x] **No hand-written migration in the end.** One was needed at first, to drop the constraints
        this database was created with before the cascade was declared - and needing it was the
        signal that the *models* were wrong rather than the generator. `buddy migrate:regenerate`
        rebuilt the whole corpus from the models (107 files from 104 models, replacing 139), which
        put every constraint inline on its `CREATE TABLE` and left the repair nothing to do. There
        is no real data yet, so replaying from scratch cost nothing
  - [x] **Nine foreign keys existed only as attributes.** Two were found by the framework's own
        audit once the corpus came from the models (`issues.milestone_id`,
        `access_tokens.organization_id`); reading the emitted DDL for `_id` columns with no
        `REFERENCES` found seven more, all of them a role rather than an owner:
        `issues.closed_by_id`, `pull_requests.merged_by_id`, `pull_requests.stack_parent_id`,
        `review_threads.resolved_by_id`, `access_tokens.revoked_by_id`,
        `pull_request_reviewers.requested_by_id`, and `repositories.parent_id`. None had a
        constraint, so a row could point at a user, milestone or repository that no longer existed.
        All declared now with the action each actually wants: `cascade` where the row is
        meaningless without its parent, `set null` everywhere else - an issue outlives whoever
        closed it, a thread stays resolved when that account is gone, and **a fork detaches from a
        deleted upstream rather than going with it**, which is what `purge.ts` does by hand today.
        The rest of the bare `_id` columns are external identifiers (`provider_id`,
        `transaction_id`) or the `_id` half of a polymorphic pair, and correctly carry no constraint
  - [x] `tests/unit/migrations-from-models.test.ts` keeps it that way. It refuses a file the
        generator would not have named, refuses hand-written commentary in the corpus (explain it
        in the model, where it survives a regeneration), and checks every relation that declares an
        `onDelete` reaches a real constraint - a model that says the database will clean up while
        the database does nothing is worse than saying nothing at all
  - [x] Verified against the real database: fifteen constraints, all `CASCADE`, none duplicated,
        and a bare `DELETE FROM repositories` - no ordering, no purge, nothing the application
        knows about - takes its labels, topics, issues and stars with it. That statement failed
        before this change
  - [x] `app/Actions/Repo/purge.ts` and `dependents.ts` are **gone** - three hundred lines that read
        the foreign keys out of `information_schema`, sorted the tables so nothing was deleted
        before the rows pointing at it, and emptied them one by one. A second implementation of a
        rule the database holds, and the kind that goes wrong quietly when somebody adds a table and
        only one of the two learns about it. The delete is one statement now
  - [x] **Deleting it uncovered a real gap, which is why it was worth doing.** A polymorphic row
        cannot be reached by a foreign key: `issue_comments.commentable_id` is an issue on one row
        and a pull request on the next, so a constraint would name one table and reject the other.
        Before the schema came from the models, `commentable_id` carried `REFERENCES issues(id)` -
        wrong, since it would have rejected every comment on a pull request - and the old walk
        followed that wrong constraint to find these rows. Removing it was right; nothing replacing
        it was not, and deleting a repository left its comments, reactions and timeline entries
        behind. `app/Actions/Repo/polymorphic.ts` sweeps exactly those five tables, as an explicit
        list somebody can read rather than a graph that decides for itself. `audit_events` and
        `activities` are deliberately left: a log that disappears with its subject cannot tell you
        what happened to it
  - [x] **`deleteWhereIn` returned how many ids it was asked about, not how many rows it deleted**,
        while its own comment said "rows matched". The sweep's first run reported removing two
        reactions and two notification mutes when it had removed one and none. The counts go into
        the audit record, so that is a lie in the one place meant to say what happened. It counts
        `RETURNING` rows now - `execute()` hands back an empty array for a plain `DELETE` with no
        count on it to read
- [x] `app/Actions/Pull/MergePullRequestAction.ts` closed issues with
      `updateTable(...).where('id', 'in', ids)`, which the query builder renders as `in $1` - so
      merging a pull request had never closed anything it said it closed. Through `updateWhereIn`
      from `app/Actions/Support/rows.ts` now
- [x] `app/Jobs/RepositoryMaintenanceJob.ts` - `git gc` and repack, nightly at 03:30, plus the
      retention sweep above. Repositories are measured before being packed rather than run through
      `gc --auto`: git's own thresholds are tuned for a person's working copy, and a forge receives
      pushes under `transfer.unpackLimit` as loose objects, so it accumulates them far faster.
      Verified against a repository with 1205 loose objects: 4820 kB became one 2 kB pack
- [x] Initial commit options on create: README, .gitignore, license. Written with plumbing
      (`hash-object`, `mktree`, `commit-tree`, `update-ref`) rather than by checking out a worktree
      to make one commit. Off by default, which is the half that matters: a repository created to
      receive an existing history must be empty, or the first push is a non-fast-forward rejection
      against a commit nobody made
- [x] Ten licences, every text verbatim in `resources/licenses/*.txt`. The long ones - Apache-2.0,
      GPL-3.0, AGPL-3.0, LGPL-3.0, MPL-2.0 - were fetched from apache.org, gnu.org and mozilla.org
      rather than typed, which is the only honest way to have them. Files rather than string
      literals: a thirty-five thousand character constant in a source file is a constant nobody
      reviews. The year and the holder are filled into the slot each document marks for them and
      nowhere else, so the three that have no such slot are left exactly as published

## Views

- [x] `resources/views/[owner]/[repository]/index.stx` - tree and README, through `RepoBrowser`
- [x] The clone box on the repository page, built from the host the page arrived on rather than
      from configuration. The two disagree exactly when it matters - behind a proxy, on a second
      domain, on a port a developer picked, or on an instance whose operator never set `APP_URL` -
      and a clone URL that is right in production and wrong on the machine you are standing at is a
      clone URL nobody trusts. The rule is in `app/Actions/Repo/cloneUrl.ts`, so it is tested rather
      than written into a template
- [x] **Every page that says "not found" now answers 404.** The status was declared in the source
      with `definePageMeta({ status })`, read before anything runs, which is no use to a page that
      is only sometimes an error page: a repository, an issue or a settings page cannot know whether
      the thing exists until it has looked. Every one of them rendered "no such repository" under a
      200, which tells a crawler, a cache and an uptime check that the page is fine. `stx` gained
      `setResponseStatus()` (0.2.155) and the render cache now carries the status with the HTML, so
      a cached not-found page does not go back to 200 on its second request
- [x] **A trailing slash 404'd on pages that plainly exist.** `/{owner}/{repository}/` looked for
      `{owner}/{repository}//index.stx` and matched no dynamic route either. Fixed in stx 0.2.155;
      it is the same page
- [x] **Every issue page was broken, and looked like a missing issue.** The server script referred
      to `ownerHandle` and declared `owner`, so it threw on its first line, stx fell back to static
      extraction, and every variable rendered undefined - which lands on the "no such issue" branch.
      Silent by design, and indistinguishable from an issue number nobody has used. One name for one
      thing is the fix; `STX_DEBUG=1` is how to see it
- [x] `.../tree/[...path].stx` and `.../commits/[ref]/index.stx` (a blob is the same route as a
      tree: the path either is a directory or it is not, which is one round trip rather than two)
- [x] **A branch with a slash in its name went to the wrong ref.** `/tree/{ref}/{path}` is ambiguous
      by construction: `fix/rounding/src` is a branch called `fix/rounding` holding `src`, or a
      branch called `fix` holding `rounding/src`, and nothing in the URL says which. Splitting on
      the first slash sent every `fix/`, `feat/` and `release/` branch - which is what branch names
      normally look like - to a ref that does not exist, git resolved nothing, and the page fell
      back to the default branch: the reader got other files under the name they clicked, with no
      error and no empty page. `splitRefAndPath` resolves it against the repository's actual refs,
      longest match first, and `joinRefAndPath` builds the links, so reading a URL and writing one
      cannot disagree
- [x] `.../commit/[sha].stx` - one commit, its message, its parents and the files it changed with
      counts. The file list only, no patch: a commit touching four hundred files would otherwise
      render the whole diff into one page, and the review screen is where a diff belongs. A merge
      says out loud that its numbers are against the first parent
- [x] `.../branches.stx` and `.../tags.stx`, each row carrying the commit on the end of it. The
      default branch is named rather than left to be inferred from the order, and tags are sorted by
      the date they point at - alphabetical order puts v10 between v1 and v2, on exactly the list
      people come to read
- [x] **Every browse view was passing the wrong path to git.** `repository.disk_path` is relative to
      `storage/repos`, so `git --git-dir annaroberts/checkout.git` resolved against the server's
      working directory, found nothing, and every loader returned its empty answer - the commit
      history, the file tree and the README all rendered "nothing here" on repositories that were
      full, with no error anywhere. `repositoryForView` now returns the absolute path, so a page
      never has to know the layout
- [x] `.../releases.stx` - newest version first, not newest publication, with the notes rendered and
      both the uploaded assets and the source archives (generated from the tag on demand, so they
      cannot drift from the tag they claim to be). A draft shows only to somebody who could have
      written it
- [x] `.../settings.stx` - name, description, default branch, visibility, topics, and a danger zone
      that says what each thing costs before somebody presses it. Reading the repository is not
      enough to see the page: somebody who cannot change anything gets the same answer a stranger
      gets, because a settings page that renders read-only is one people file bugs about
- [x] **Every form in the product was returning 403.** The CSRF middleware is double-submit and takes
      its value from an `x-csrf-token` header *or* a `_token` body field. A single-page app reads the
      cookie and echoes the header; this application deliberately runs no client-side JavaScript, so
      its forms could send neither - and opening an issue, commenting, creating a label, creating a
      milestone and merging a pull request all failed before reaching an action. `<CsrfField />` puts
      the token in the body, in one component rather than a line per form, because a form that
      forgets it is a button that silently does nothing
- [x] `resources/views/new.stx` - create a repository. The owner list is built from the same
      membership rule the endpoint enforces, because offering an owner the endpoint would refuse is
      handing somebody a 403 after they have filled in a form. The scaffold boxes start unticked and
      the page says why: a first commit here means the first push of an existing project is refused
      for not being a fast forward, against a commit nobody wrote, which reads as the forge being
      broken rather than as a choice made on this page
- [x] Components: `RepoHeader`, `FileTree`, `CodeView`, `CloneUrlBox`, `BranchPicker`,
      `CommitList`, `MarkdownContent`. Each one takes rows that are already decided - a name, a
      link, one piece of text - shaped by `app/Actions/Browse/rows.ts` where a test can reach them.
      A component with no `<script>` block cannot import anything and one with a script can, which
      is exactly what makes building links inside a template tempting; the link rule has already
      been wrong once, and it was wrong in a way no test could have caught while it lived in the
      markup. `RepoBrowser` is 203 lines rather than 352, and the four ways a file is not shown -
      missing, binary, too large, markdown - are one decision in the view rather than four branches
      in the template

## Later in this phase

- [x] SSH transport, through **[ts-ssh](https://github.com/stacksjs/ts-ssh)**. `./buddy git:ssh`
      serves `git clone`, `git fetch` and `git push` over a key, on port 2222 by default because
      binding 22 needs root and a forge that asks to be run as root gets run as root. The host key
      is created on first start and never regenerated: one that changes between restarts makes
      every client that ever connected print the warning about a changed fingerprint, which is the
      warning that is supposed to mean something.

      What is in `app/Actions/Git/ssh.ts` is only what a protocol library must not decide for a
      forge - which key is whose (`ssh_keys`, by fingerprint), what a command string means, and
      whether it is allowed (`mayUseService`, the same function the HTTP routes ask, because a
      second opinion about permissions is two answers waiting to disagree). Everything below that
      is the package: the handshake in order, curve25519, AES-GCM and AES-CTR with
      encrypt-then-MAC, channels and their windows, and strict key exchange, which closes Terrapin.

      Rekeying matters more here than it looks. RFC 4253 asks for new keys after an hour or a
      gigabyte, which a clone of any large repository passes, and OpenSSH renegotiates on its own
      schedule whether or not a server is ready - one that is not leaves the client stuck at
      `rekeying in progress` and unable to send another byte. A clone survives that by accident
      because the client is only receiving; **a push does not**, which is the transport this forge
      cares about most. It is implemented and tested against the real client now

      Two things the wiring had to get right and one it had to fix. The command parser is not a
      shell - no expansion, no globbing, and nothing but the two services, because somebody with a
      valid key sends that string. `--stateless-rpc` is the HTTP framing and must not be passed
      here, or the client hangs waiting for a round nobody will send. And a push over SSH now
      carries the pusher into the hooks through `REVIEWOS_ACTOR_ID`: over HTTPS that comes from the
      Authorization header, and without it a bypass over SSH was recorded against nobody, which is
      the one thing the audit trail exists to prevent

      `tests/e2e/git-ssh.test.ts` runs the real git and ssh clients at it: the clone names the file
      it expects, because a transport that serves the wrong repository looks perfect from the
      client's side. A stranger's registered key can read the public repository and cannot push to
      it, cannot see the private one, and an unregistered key cannot connect at all
- [x] Git LFS, through **[ts-git-lfs](https://github.com/stacksjs/ts-git-lfs)** - a package of its own,
      because pointer files and the batch API are a specification anybody implementing LFS needs and
      not something a forge should own. What is wired here is the three things it will not decide
      for a host: where objects live (`storage/lfs/{owner}/{name}`, beside the bare repository and
      never inside it, so an LFS object never appears in `git count-objects` and makes the size
      accounting wrong), who may read and write (`mayUseService`, the same function the wire
      protocol asks - a second opinion about permissions is a bug waiting for the two to disagree),
      and where locks live (`repository_lfs_locks`, because a lock a deploy forgets is a lock
      somebody was relying on)
  - [x] **A real `git lfs` client found a bug eight passing tests did not.** An anonymous client is
        refused with **401 and a challenge**, not 403. `git lfs` tries anonymously first - it cannot
        know whether a public repository needs a credential to push to - and it treats 403 as final,
        so the push failed with "you may not write to this repository" while the client was holding
        a perfectly good token. Every test sent credentials, so every test passed
  - [x] The client cases are behind `REVIEWOS_LFS_CLIENT_TESTS=1`. Spawning a Go binary is what has
        to be survivable rather than what is being tested, and on a host whose swap is exhausted the
        kernel kills the process group rather than the allocation
- [ ] Commit signature verification against registered GPG keys. **Written and unit-tested, not
      wired up.** `app/Actions/Git/signature.ts` reads the signature off a commit object and decides
      which registered keys could have made it; `verify.ts` builds a throwaway keyring from those
      keys and asks **git** to verify, rather than running gpg itself - the same rule as the rest of
      this phase, and it also avoids owning the payload reconstruction, which is the one computation
      here where being slightly wrong accuses somebody of forging a commit they wrote.
      Two rules it will not bend on, both tested: a good signature by a key nobody registered is not
      verified, and a good signature by a key that does not claim the commit's author address is not
      verified either - anybody can sign a commit claiming to be somebody else.
      `gnupg.org` is a declared pantry dependency, beside `git`, for the same reason: the binary
      does the cryptography rather than a reimplementation of OpenPGP in TypeScript.
      What is missing is smaller than it was written down as. This said the blocker was memory
      pressure - gpg allocates locked, unswappable secure memory, and on a machine whose swap is
      exhausted the kernel kills the whole process group rather than the allocation. That did
      happen. Run again with headroom, the process is not killed and `git verify-commit` answers
      `error: cannot run gpg: No such file or directory`: **there is no gpg on this machine.**
      `gnupg.org` is in `deps.yaml`, and `pantry install gnupg.org` reports twenty-eight packages
      installed while `pantry list` shows none, nothing lands on `PATH`, and no `gnupg.org`
      directory appears under the pantry root. The installed pantry is 0.11.12 against a 0.11.18
      checkout, so it may already be fixed there.
      The wrong diagnosis was the expensive part: a blocker recorded as "the kernel kills us" reads
      as unfixable and gets left alone. The verification itself is still proven - the same keyring
      and signature this code builds verify `GOODSIG` when gpg is run from a shell that has one.
      The gpg-dependent tests stay behind `REVIEWOS_GPG_TESTS=1` until there is a gpg to run

## Browsing

- [x] `resources/components/RepoBrowser.stx`: tree, file and README in one component, so the root
      route and the deep-path route cannot drift apart
- [x] `resources/functions/browse.ts`: ls-tree parsing, sorting, breadcrumbs, README detection,
      sizes - all pure and tested away from git
- [x] `app/Actions/Browse/load.ts`: `listTree`, `readBlob`, `lastCommit`, `branchNames`
- [x] Binary and oversized files are declined rather than streamed into the page
- [x] 30 unit tests, including a filename containing a newline, which is legal and is why the
      listing is NUL-delimited rather than line-delimited
- [x] Branch picker, a plain `<details>` so it works before any JavaScript runs
- [x] Syntax highlighting in the file view, server-side, sharing one token palette with the diff
      via the layout so the two cannot disagree about what a keyword looks like
- [x] File view verified in a browser: `config/app.ts` renders 33 numbered lines with keyword,
      string and comment tokens
- [x] Tag picker alongside branches, newest first and capped at 30
- [x] Commit history view

- [x] Commit history at `/owner/repo/commits/ref`
- [x] `tagNames` and `commitHistory` loaders, NUL-delimited for the same reason the tree listing is
- [x] Tag picker in the ref menu, and browsing at a tag verified

### Catch-all routing, resolved

Deep paths now work: `/stacks/stacks/tree/main/storage/framework` renders that directory, and
`/stacks/stacks/tree/v0.70.230/app` browses at a tag.

It took four fixes, because stx compiled routes in four separate places and each got catch-alls
wrong differently:

1. `stx-router` collected parameter names in the order its three replace-sweeps ran, while capture
   groups end up in pattern order, so any pattern mixing a catch-all with ordinary segments bound
   every value to the wrong name
2. the dev server built names straight from the brackets, keeping the dots (`params['...path']`
   rather than `params.path`) and compiling the segment to `([^/]+)`, which cannot span a separator
3. the production server captured `:name` greedily, taking `path*` including the asterisk
4. SSR matched `\w+`, and an asterisk is not a word character, so a catch-all route did not exist
   there at all

Three now share `stx-router`'s compiler, which was already correct; the fourth keeps its own because
it emits several alternates per file, but no longer disagrees about what a catch-all means. Released
as stx 0.2.151.

The app also carried eight copies of stx-router at three versions, which is why patching one never
took effect. `overrides` pins a single version.
