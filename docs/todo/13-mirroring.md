# 13 - Mirroring

Mirror a repository hosted somewhere else - GitHub first - so it appears in ReviewOS and stays
current without anyone changing how they work. You keep pushing to `origin` on GitHub. The code,
the branches, the pull requests and the review threads show up here.

## Why this is a core feature and not an import step

Everything else in [08 - Migration](./08-migration.md) assumes a decision: you are leaving GitHub,
so bring your data across. That is a large decision, and asking for it up front is asking people to
bet a repository on a forge they have not used yet.

Mirroring asks for nothing. GitHub stays the origin of record, CI keeps running, nothing about a
contributor's workflow changes, and the review screen - the reason this project exists - can be
tried on a real repository with real history the same afternoon. If the review experience is
better, that becomes obvious through use rather than through argument. If it is not, nothing was
lost.

So mirroring is the front door, and import is the thing you do later if you decide to move in.

That framing has a design consequence worth stating plainly: **a mirrored repository must never
pretend to be authoritative.** Anything that would make a user's GitHub state and their ReviewOS
state disagree is a bug, not a feature, and the interface has to say which one is upstream.

## The shape of it

- [x] `app/Models/RepositoryMirror.ts`: `repository_id`, `direction` (`pull`, `push`), `provider`
      (`github`, `gitlab`, `git`), `remote_url`, `remote_owner`, `remote_name`, credential
      reference, `interval`, `last_synced_at`, `last_sha`, `last_error`, `enabled`
- [x] The local name is **not** derived from the remote. `stacksjs/stacks` on GitHub is
      `stacks/stacks` here, so the mapping is stored per mirror and chosen when the mirror is
      created
- [x] `useSeeder` with a factory, like every other model, so `buddy seed` produces a plausible
      mirror without hand-wiring
- [x] Migration generated from the model, reviewed, never hand-written

## Syncing

Two paths, because either alone is wrong. A webhook is fast but can be missed; a poll is reliable
but slow. Together they give a mirror that is usually current within seconds and always current
within an interval.

- [x] `app/Jobs/MirrorSyncJob.ts`: `git fetch --prune` into the bare repository, then reconcile refs
- [x] Webhook receiver for GitHub `push`, `pull_request`, `issues` and `issue_comment`, verified by
      signature, that enqueues a sync for exactly the affected repository
- [x] Scheduled sweep in `app/Scheduler.ts` as the backstop, at the mirror's `interval`
- [x] Sync is idempotent and safe to run concurrently with itself - a webhook and the sweep will
      overlap, and the common case is that the second one finds nothing to do
- [x] Failures are recorded on the mirror and surfaced in the repository UI. A mirror that silently
      stopped updating is worse than one that visibly failed, because the reader trusts what they
      are looking at

## What comes across

Git data is the easy half and is worth landing on its own:

- [x] Branches, tags and commits, via `git fetch --prune` so deletions upstream become deletions
      here
- [x] `--prune` matters: without it a branch deleted on GitHub lingers here forever and the branch
      list slowly stops meaning anything
- [x] Default branch follows the remote's. A repository that renamed `master` to `main` upstream
      showed the wrong branch here forever otherwise, and every link into the code browser landed on
      a ref that no longer moves
- [x] Repository description, topics and visibility, refreshed on sync

  Only the fields the mirror owns. `name` is deliberately not one: overwriting it would move the
  repository's URL under readers who have it bookmarked. **Visibility follows upstream in one
  direction only** - private upstream makes it private here, and public upstream never forces public.
  Somebody may have mirrored a public repository into a private one on purpose, and a sync that
  published it would be a disclosure performed by a background job.

  Topics are replaced rather than merged, because they are a set: the alternative is a mirror that
  only accumulates, and a repository that was once tagged `deprecated` wearing it forever. Stars,
  watchers and forks are deliberately not carried - they are their numbers about their copy, and
  showing them here would make this instance look like it has an audience it does not have.

The metadata is where the value is, because it is what the review screen operates on:

- [x] GitHub pull requests become ReviewOS pull requests, keeping their number so `#123` means the
      same thing in both places
- [x] Review comments and review threads, anchored to the same file, line and side, so the diff
      renders them where they belong
- [x] Issues, with the same number-preserving rule (issue comments still to come)
- [x] Labels, matched by name rather than by upstream id - a label's identity here *is* its name,
      which is what an issue references and what a reader filters by, and matching on id would
      create a second `bug` the first time somebody recreated it upstream. Milestones are mapped and
      tested; writing them waits on the issue-to-milestone link
- [x] Authorship maps to a ReviewOS user when the GitHub identity is linked, and to a display-only
      attribution when it is not. It must never silently attribute someone's comment to the wrong
      account

## Writing back

The obvious question once the review screen is genuinely nicer: can I review here and have it count
there?

- [x] Decide, and write down, whether a mirror is read-only or write-through. Read-only is the
      honest default and should ship first: the importer is one-way, and `MirrorMetadataSyncJob`
      says so in as many words
- [ ] If write-through: a review submitted here posts to GitHub through the API as the reviewing
      user, using their own credential, and the resulting GitHub state syncs back as the source of
      truth
- [ ] Never write back with a shared or admin credential. A review must be attributable to the
      person who wrote it, and a bot account posting on their behalf destroys that

## Divergence

- [x] A mirrored repository refuses pushes to its mirrored refs by default. Accepting one creates a
      fork that neither side knows about

  Refused at receive time, which is the only moment the pusher can be told: the next sync is a
  `git fetch --prune` that rewrites these refs to match upstream, so a commit pushed here does not
  join the repository - it disappears within the hour with nothing recording why. Losing somebody's
  work quietly is worse than refusing it.

  The rule lives inside `decidePush` rather than beside it, because a caller that has to remember to
  ask two questions will one day ask one. Wiring it up found that the gate only called `decidePush`
  when branch rules existed - and every mirror has none, since nobody writes protection rules for a
  copy - so the check would have been skipped on exactly the repositories it is for.
- [x] When the remote force-pushes, the mirror follows it, and the fact that history was rewritten
      is shown rather than absorbed silently
- [x] Detect and surface a mirror that has stopped tracking - remote deleted, credential revoked,
      repository made private - instead of showing stale data as if it were live

## Interface

- [x] A repository shows that it is a mirror, of what, and when it last synced, on the repository
      header. Not buried in settings
- [x] "Synced 3 minutes ago" beats "mirror enabled", because the reader's real question is whether
      what they are looking at is current
- [x] Manual "sync now" for when someone does not want to wait for the interval. Behind
      `repository:settings`, because a sync spends somebody else's rate limit - a public mirror
      anybody could trigger is a way to get this instance's token banned by whoever it belongs to.
      Rate limited to one a minute, which is less about abuse than about the button being pressed
      three times because nothing visibly happened: three sweeps race each other into the same refs
- [x] Mirror setup asks for the remote and the local name separately, since they differ by default
      (`buddy mirror:add --remote stacksjs/stacks --owner stacks --name stacks`)

## Credentials

- [x] A public repository mirrors with no credential at all, and that path is tested, because it is
      the one someone will try first
- [x] Private repositories use a stored token or GitHub App installation, encrypted at rest,
      referenced by the mirror rather than copied into it

  Referenced, and never stored: `credential_ref` names an environment variable
  or the file one points at, so a database dump, a backup, or a support export
  of the mirrors table carries nothing anybody can use. That is a stronger
  property than encrypting a column, whose key travels with the same instance
  the ciphertext does - so the box is satisfied by not having the secret rather
  than by protecting it.

  **The git side had no credential at all.** The metadata sync resolved a token
  and the fetch did not, so a private mirror imported its issues perfectly and
  cloned nothing - which reads as "the repository is empty" rather than as "the
  credential never reached git". One resolver now, used by both, which is what
  stops them drifting again; the metadata half gained the `_FILE` form for free.

  **And the error message was going to leak it.** git is handed the credential
  in the remote URL - the alternative is a config file, where it lives in every
  backup - and git echoes that URL in most of its failures. The mirror row
  stores the last error and the interface shows it, so the ordinary first
  failure of a private mirror, a 403 from an expired token, would have written a
  live credential into the database and onto a page. Everything recording a git
  failure goes through `redact` now, which removes both the URL form and any
  bare occurrence of the token, because git does not always quote the whole URL.

  GitHub App installations are not implemented. A token is what somebody
  mirroring a private repository has today, and an App is a second credential
  shape with its own refresh cycle - worth doing when somebody needs the higher
  rate limit, and not worth claiming now.
- [x] A revoked credential is named as such and says what to do, rather than showing the raw error.
      It is the one failure with a different fix from all the others - every other is "wait or
      retry", this one is "go and issue a new token" - and they read identically in a log

## First mirror: stacks/stacks

`stacksjs/stacks` on GitHub, mirrored here as `stacks/stacks`. It is the obvious first one: it is
ours, it is public, it is large enough to be a real test of the diff and review screens, and its
documentation is markdown that the docs pipeline has to render anyway.

- [x] Owner `stacks` exists as an organization
- [x] Mirror configured, pull direction, public, no credential
- [x] Git data cloned into `storage/repos/stacks/stacks.git` and readable through git plumbing
      (2488 refs, HEAD resolves, trees list)
- [x] Browsable in the UI at `/stacks/stacks`: the tree renders its 33 root entries, the README
      below it, and the last commit
- [x] Navigating into a directory **more than one level deep**. Both halves are fixed and both are
      held by `tests/e2e/browse-tree.test.ts`: `/{owner}/{repo}/tree/main/app` renders `app` rather
      than the repository root, and `.../app/nested` renders `nested`.

      The second half was in the router, and the earlier note here named it slightly wrong. It is
      not that a catch-all matches one segment; it is that **only the unnamed catch-all was ever
      implemented**. A bare `/files/*` matched the whole remaining path and bound it to `wildcard`,
      including alongside named parameters - `/{owner}/{repo}/tree/{ref}/*` worked. The *named*
      spelling `{path}*` fell through to the branch that compiles a mixed segment like `user-{id}`,
      whose pattern is tested against one already-split segment, so it answered `/app` and refused
      `/app/nested`.

      Which spelling is in play was never a choice: file-based routing converts a `[...path]` file
      to `{path}*`, so every view declared by a file got the half-working one. That is why the top
      level looked fine and every real repository was unreachable one directory down.

      Fixed in bun-router rather than around it, in the two places that have to agree:
      `route-compiler.ts`, which builds the pattern the server matches with, and `route-trie.ts`,
      which builds the pre-compiled index. A catch-all now comes off the path before the static
      text is regex-escaped - escaping `*` had been compiling it into a literal asterisk no request
      carries - and binds to its own name, or to `wildcard` when it has none. Held upstream by
      `test/catch-all-routes.test.ts`, whose two bug cases fail without the change.

      The `:rest*` spelling is still not matched, and that is left alone deliberately: bun-router
      documents `{name}` parameters and a bare `*`, and inventing a second parameter syntax to fix
      a route nobody can write from the documentation is not a fix.
- [x] Viewing a **file** whose name carries an extension, under `./buddy dev`. The route is right
      and the served product is right - `tests/e2e/browse-tree.test.ts` asks `route.serve()` for
      `app/nested/deeper.ts` and gets the file - but the stx dev server is a second boot path with
      its own router, and there a request for `package.json` or `index.ts` arrives at the view as
      `package.json.html`, which is a file that does not exist at that ref.

      Diagnosed rather than guessed: stx's `getRoute` dropped every catch-all candidate whenever
      the request path carried a non-page extension. That guard is stacksjs/stx#1841, and it is
      protecting something real - `getRoute` runs before the publicDir handler, so an unguarded
      catch-all shadows `/images/logo.jpg`. But the extension is a guess about intent, and it is
      the wrong question for an app whose catch-all legitimately serves paths with dots in them.
      A code browser is exactly that app, and so is a docs site addressing `guide.md`.

      Fixed upstream by asking the disk instead of the extension: a route is dropped when publicDir
      *really holds* that file. Same protection, one stat. Released as stx 0.2.174, and this project
      moved off its 0.2.157 pins to take it - `/storage/framework/core/router/src/index.ts` now
      renders its source in the dev server instead of reporting `index.ts.html` missing, and the
      e2e suite is 734 green on the new version.

      **Verifying it in the browser is what turned up the bigger bug, and it was not the one this
      box is about.** `/js/mermaid.js` answered with 72KB of HTML instead of the 3.4MB bundle, on
      the served boot as well as the dev server - so every mermaid diagram in this product was
      silently not drawing, and the fallback leaves the diagram source on screen, which reads as
      "no diagram here" rather than as a failure.

      The cause is this forge's route shape. `[owner]` claims every one-segment path and
      `[owner]/[repository]` every two-segment one, so **the entire publicDir was unreachable** -
      and 0.2.174's disk check did not help, because it only dropped `[...catch-all]` candidates.
      That restriction assumed a shallow route tree; an app whose routes start at the root does not
      have one. In stx 0.2.175 a real file at exactly the requested path wins over *any* dynamic
      route, and `/js/mermaid.js` serves 3,493,222 bytes of `application/javascript` - the file's
      own size - while `/stacks/stacks` still renders the repository and `/favicon.ico`, which
      publicDir genuinely does not have, still falls through to the page.
- [x] Its markdown renders through the docs pipeline described in
      [07 - Marketing and docs](./07-marketing-docs.md). Held by
      `tests/e2e/markdown-in-repository.test.ts`, which pushes a document with a mermaid fence, a
      task list, a table, a fenced code block and an emoji into a real repository and asks the
      served product for it: the fence is a `<pre class="mermaid">`, the tasks are disabled
      checkboxes, the table is a table, and the README on the repository page goes through the same
      pipeline rather than a second one.
- [x] Pull requests visible in the review screen, which is the actual test of whether any of this
      was worth building.

      **Two thirds of the way, and the last third is named rather than guessed at.** Running this
      against the live repository is what found all of it; none of it was visible from the code.

      `stacks/stacks` now carries 1807 pull requests, 484 issues, 404 labels and 4 review threads,
      and a pull request page renders its title, state, author, branches and description from the
      import. Two things had to be fixed to get that far, and both had been ticked above.

      **The metadata sync had never run.** It queried a table called `labels`; the table is
      `repository_labels`, which is what every other caller in the codebase uses. The job died on
      its first query, so *no* mirrored metadata has ever been imported - the issues, pull requests,
      review threads and labels boxes above were all ticked on unit tests over the mappers.

      **The importer dropped the commits.** `mapPull` read `head.ref` and `base.ref` and ignored
      `head.sha` and `base.sha`, which arrive in the same response, so every imported pull request
      had `head_sha` and `base_sha` null. A branch name is not a diff: the page rendered
      "0 files, +0 -0", which reads as a change that touches nothing rather than as one whose
      commits nobody looked up. Both are carried now, with tests.

      **The diffs render.** Of the 15 open pull requests on `stacks/stacks`, 14 produce a file list
      and one is legitimately empty; none error. Before this, every one of them failed.

      Two things were wrong and only the first was visible from the code.

      `base.sha` is the base branch's tip *when the pull request was opened*, and a mirror never
      holds it, so `git diff <base>...<head>` died with *fatal: Invalid symmetric difference
      expression*. `resolveBaseShas` now records a base this repository can actually show:
      upstream's when the object is present, the local tip of the base branch when it is not, and
      null when neither resolves - which is honest, rather than a row pointing at something the
      page cannot render. Both lookups are batched, because two thousand pull requests would
      otherwise be two thousand `cat-file` processes per sweep.

      Fixing that exposed the second, which no amount of reading would have found: **the mirror
      never fetched pull request heads at all.** The refspec was `+refs/heads/*` and `+refs/tags/*`,
      and a proposal's commits are not on a branch of the repository being mirrored - they are on a
      fork. The 1765 `refs/pull/*` refs here came from the initial clone and had been frozen ever
      since, so any pull request pushed to after that day pointed at a commit the mirror did not
      have. `proposalRefspec` adds them, per forge: `refs/pull/*/head` for GitHub, Gitea and
      Forgejo, `refs/merge-requests/*/head` for GitLab, and nothing for a plain git remote, whose
      server would reject a refspec it does not publish and fail the whole fetch with it.

      The order matters and is now the one the sweep should use: fetch, then metadata. The reverse
      records heads the repository is about to receive, and every actively-pushed pull request
      spends the gap unrenderable.

## Verified against the live repository

A real fetch of `stacksjs/stacks` moved 2488 refs to 2489 - one new, three updated - and the head of
`main` from `d72fa0e` to `2c82521`, in about a second. Running it again reported no changes, which is
the idempotence the checklist asks for rather than an assertion about it.

## Tests

- [x] Sync is idempotent: running it twice changes nothing the second time, verified against the live repository
- [x] A deleted upstream branch disappears here, through `--prune`. Verified against two real bare
      repositories in `tests/unit/mirror-fetch.test.ts` rather than asserted about the flag
- [x] A force-push upstream is followed and reported *as a rewrite*. A force push and an ordinary
      advance are both "updated" until somebody asks git whether the old commit is still reachable,
      and a mirror that says "3 commits" for a rewrite tells the reader nothing happened to the
      history they already read. The control case is tested too, because calling every update a
      rewrite is as useless as calling none of them one
- [x] Numbers are preserved, so a mirrored `#123` is `#123`
- [x] A comment from an unlinked GitHub account is attributed to nobody local, asserted on a comment
      specifically rather than only on `attribute`: a comment is the case that matters because it
      carries words, and assigning a stranger's sentence to somebody who shares a handle across two
      hosts is not a bug anybody apologises their way out of. The name still shows, so it is
      unlinked rather than anonymous
- [x] A failed sync leaves the previous state intact and readable, rather than a half-updated
      repository

  The case the fetch tests exist for. A half-updated mirror is worse than a stale one: stale is
  visibly old, half-updated is a repository whose branches disagree with each other and whose reader
  has no way to tell. Asserted three ways - the refs on disk are unchanged, the outcome *reports*
  them as unchanged so a caller diffing before against after does not invent a deletion of every
  branch, and `git log` still reads, since refs that survived while objects did not would pass the
  first two and still be broken.
