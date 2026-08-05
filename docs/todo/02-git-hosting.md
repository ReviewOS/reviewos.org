# 02 - Git hosting

Actually hosting git: repositories on disk, the wire protocol, and reading code in a browser.

The rule for this whole phase: **the system git binary does the git work.** It is a declared pantry
dependency. Do not add a git library, and do not reimplement packfile handling in TypeScript. Every
path that touches a repository on disk goes through `app/Actions/Git/`, so the storage layout stays
known to exactly one place.

## Storage

- [x] Bare repositories at `storage/repos/{owner}/{repository}.git`
- [ ] One helper that resolves an owner and repository name to an absolute path, rejecting `..`,
      absolute paths, and anything that escapes the root. Every other caller uses it.
- [x] `git init --bare` on creation, with `core.hooksPath` pointed at a shared hook directory. One
      shared directory rather than a copy of the scripts in every repository: copies drift, and the
      repositories nobody pushes to would keep whichever version they were created with, which is
      exactly where a silent failure goes unnoticed longest. `buddy git:hooks` writes them and
      repoints every repository, which is the deploy step after an upgrade.
- [ ] Repository size accounting, updated after receives
- [ ] Deleting a repository moves it aside with a timestamp rather than unlinking, so an accidental
      delete is recoverable for a retention window

## Models

- [x] `app/Models/Repository.ts`: polymorphic `owner` (user or organization), `name`, `slug`,
      `description`, `visibility` (public, private, internal), `default_branch`, `is_fork`,
      `parent_id`, `is_archived`, `is_template`, `size_kb`, `stars_count`, `forks_count`,
      `open_issues_count`, `pushed_at`
- [ ] Unique constraint on `(owner_type, owner_id, name)`
- [ ] Counter columns are denormalized on purpose; every writer updates them in the same transaction
      as the row it counts
- [x] `app/Models/RepoCollaborator.ts`: `repository_id`, `user_id`, `permission`
- [x] `app/Models/Star.ts`, `app/Models/Watch.ts` with a `subscription` level (all, participating,
      ignore)
- [x] `app/Models/ProtectedBranch.ts`: pattern, required approvals, dismiss stale reviews, required
      status checks, restrict who can push, allow force push, allow deletion
- [ ] `app/Models/RepoTopic.ts`
- [ ] `app/Models/Release.ts` and `app/Models/ReleaseAsset.ts`

## Smart HTTP

- [ ] `routes/git.ts`, registered in `app/Routes.ts` with an empty prefix so URLs are
      `/{owner}/{repository}.git/...`
- [x] `GET /{owner}/{repository}.git/info/refs?service=git-upload-pack` (clone and fetch discovery)
- [ ] `POST /{owner}/{repository}.git/git-upload-pack`
- [ ] `POST /{owner}/{repository}.git/git-receive-pack`
- [ ] Stream request and response bodies. Buffering a packfile is how this breaks on a real
      repository, and it will pass every test written against a small one.
- [x] HTTP basic auth: username plus access token. Password login over git is not accepted.
      This authenticated against a `personal_access_tokens` table that no migration ever created, so
      every authenticated git request failed on a missing relation. It now goes through the access
      tokens from [phase 1](./01-foundation.md#access-tokens), and the token's own grants decide
      the answer: a read-only token belonging to a maintainer cannot push, and a token scoped to two
      repositories cannot touch a third. The username is not checked, because the token already
      names its owner and treating it as meaningful would fail a correct token for a cosmetic
      reason.
- [ ] Anonymous read for public repositories; everything else authenticates
- [ ] Correct content types and the `no-cache` headers git expects
- [ ] Tests: clone, fetch, push, shallow clone, and a repository large enough that streaming matters

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

- [ ] Scan the incoming pack for credential shapes before accepting it: provider tokens with a known
      prefix first, since those are unambiguous, then private keys, then high-entropy strings in
      assignment position
- [ ] Reject with a message git prints legibly, naming the file, the line, and what it looks like.
      A rejection the pusher cannot act on gets bypassed once and disabled forever.
- [ ] A bypass that requires a reason and is recorded in the audit log, because a false positive on
      a test fixture at 6pm will otherwise turn the whole feature off
- [ ] Patterns are configurable per instance, and a self-hosted instance can add its own
- [ ] Scan history on demand for a repository that predates this, reporting rather than rejecting
- [ ] Tests: a known token shape is rejected, a documented example placeholder is not, and the
      bypass is logged

## Browsing

- [ ] `app/Actions/Browse/TreeAction.ts` - directory listing at a ref and path
- [ ] `app/Actions/Browse/BlobAction.ts` - file contents, with binary detection and a size ceiling
- [ ] `app/Actions/Browse/CommitsAction.ts` - paginated history, optionally scoped to a path
- [ ] `app/Actions/Browse/CommitAction.ts` - a single commit with its diff
- [ ] `app/Actions/Browse/BranchesAction.ts`, `TagsAction.ts`
- [ ] `app/Actions/Browse/BlameAction.ts`
- [ ] `app/Actions/Browse/CompareAction.ts` - two refs, the basis for opening a pull request
- [ ] `app/Actions/Git/RawFileAction.ts` and `ArchiveAction.ts` (zip and tar.gz via `git archive`)
- [x] Syntax highlighting server-side. The client does not download a highlighter.
- [ ] Render README, and markdown files generally, at the tree view

## Repository management

- [x] `app/Actions/Repo/CreateRepositoryAction.ts` - row and bare repository together, cleaning up
      the row if the disk operation fails
- [ ] `app/Actions/Repo/UpdateSettingsAction.ts`, `DeleteRepositoryAction.ts`,
      `TransferRepositoryAction.ts`, `ArchiveRepositoryAction.ts`
- [ ] `app/Actions/Repo/ForkRepositoryAction.ts` using `git clone --bare`, recorded as a fork
- [ ] `app/Actions/Repo/StarAction.ts`, `WatchAction.ts`
- [ ] `app/Jobs/RepositoryMaintenanceJob.ts` - `git gc` and repack, scheduled nightly
- [ ] Initial commit options on create: README, .gitignore, license

## Views

- [ ] `resources/views/[owner]/[repository]/index.stx` - tree, README, clone box
- [ ] `.../tree/[...path].stx`, `.../blob/[...path].stx`, `.../commits.stx`, `.../commit/[sha].stx`
- [ ] `.../branches.stx`, `.../tags.stx`, `.../releases.stx`, `.../settings.stx`
- [ ] `resources/views/new.stx` - create a repository
- [ ] Components: `RepoHeader`, `FileTree`, `CodeView`, `CloneUrlBox`, `BranchPicker`,
      `CommitList`, `MarkdownContent`

## Later in this phase

- [ ] SSH transport. It needs a separate daemon and key-based auth, so it lands after HTTPS works
      end to end.
- [ ] Git LFS
- [ ] Commit signature verification against registered GPG keys

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
