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

- [ ] `app/Models/RepositoryMirror.ts`: `repository_id`, `direction` (`pull`, `push`), `provider`
      (`github`, `gitlab`, `git`), `remote_url`, `remote_owner`, `remote_name`, credential
      reference, `interval`, `last_synced_at`, `last_sha`, `last_error`, `enabled`
- [ ] The local name is **not** derived from the remote. `stacksjs/stacks` on GitHub is
      `stacks/stacks` here, so the mapping is stored per mirror and chosen when the mirror is
      created
- [ ] `useSeeder` with a factory, like every other model, so `buddy seed` produces a plausible
      mirror without hand-wiring
- [ ] Migration generated from the model, reviewed, never hand-written

## Syncing

Two paths, because either alone is wrong. A webhook is fast but can be missed; a poll is reliable
but slow. Together they give a mirror that is usually current within seconds and always current
within an interval.

- [ ] `app/Jobs/MirrorSyncJob.ts`: `git fetch --prune` into the bare repository, then reconcile refs
- [ ] Webhook receiver for GitHub `push`, `pull_request`, `issues` and `issue_comment`, verified by
      signature, that enqueues a sync for exactly the affected repository
- [ ] Scheduled sweep in `app/Scheduler.ts` as the backstop, at the mirror's `interval`
- [ ] Sync is idempotent and safe to run concurrently with itself - a webhook and the sweep will
      overlap, and the common case is that the second one finds nothing to do
- [ ] Failures are recorded on the mirror and surfaced in the repository UI. A mirror that silently
      stopped updating is worse than one that visibly failed, because the reader trusts what they
      are looking at

## What comes across

Git data is the easy half and is worth landing on its own:

- [ ] Branches, tags and commits, via `git fetch --prune` so deletions upstream become deletions
      here
- [ ] `--prune` matters: without it a branch deleted on GitHub lingers here forever and the branch
      list slowly stops meaning anything
- [ ] Default branch follows the remote's
- [ ] Repository description, topics and visibility, refreshed on sync

The metadata is where the value is, because it is what the review screen operates on:

- [ ] GitHub pull requests become ReviewOS pull requests, keeping their number so `#123` means the
      same thing in both places
- [ ] Review comments and review threads, anchored to the same file, line and side, so the diff
      renders them where they belong
- [ ] Issues and issue comments, with the same number-preserving rule
- [ ] Labels and milestones
- [ ] Authorship maps to a ReviewOS user when the GitHub identity is linked, and to a display-only
      attribution when it is not. It must never silently attribute someone's comment to the wrong
      account

## Writing back

The obvious question once the review screen is genuinely nicer: can I review here and have it count
there?

- [ ] Decide, and write down, whether a mirror is read-only or write-through. Read-only is the
      honest default and should ship first
- [ ] If write-through: a review submitted here posts to GitHub through the API as the reviewing
      user, using their own credential, and the resulting GitHub state syncs back as the source of
      truth
- [ ] Never write back with a shared or admin credential. A review must be attributable to the
      person who wrote it, and a bot account posting on their behalf destroys that

## Divergence

- [ ] A mirrored repository refuses pushes to its mirrored refs by default. Accepting one creates a
      fork that neither side knows about
- [ ] When the remote force-pushes, the mirror follows it, and the fact that history was rewritten
      is shown rather than absorbed silently
- [ ] Detect and surface a mirror that has stopped tracking - remote deleted, credential revoked,
      repository made private - instead of showing stale data as if it were live

## Interface

- [ ] A repository shows that it is a mirror, of what, and when it last synced, on the repository
      header. Not buried in settings
- [ ] "Synced 3 minutes ago" beats "mirror enabled", because the reader's real question is whether
      what they are looking at is current
- [ ] Manual "sync now" for when someone does not want to wait for the interval
- [ ] Mirror setup asks for the remote and the local name separately, since they differ by default

## Credentials

- [ ] A public repository mirrors with no credential at all, and that path is tested, because it is
      the one someone will try first
- [ ] Private repositories use a stored token or GitHub App installation, encrypted at rest,
      referenced by the mirror rather than copied into it
- [ ] A revoked credential disables the mirror and says so, rather than retrying forever

## First mirror: stacks/stacks

`stacksjs/stacks` on GitHub, mirrored here as `stacks/stacks`. It is the obvious first one: it is
ours, it is public, it is large enough to be a real test of the diff and review screens, and its
documentation is markdown that the docs pipeline has to render anyway.

- [ ] Owner `stacks` exists as an organization
- [ ] Mirror configured, pull direction, public, no credential
- [ ] Git data synced and browsable
- [ ] Its markdown renders through the docs pipeline (see [07](./07-marketing-docs.md))
- [ ] Pull requests visible in the review screen, which is the actual test of whether any of this
      was worth building

## Tests

- [ ] Sync is idempotent: running it twice changes nothing the second time
- [ ] A deleted upstream branch disappears here
- [ ] A force-push upstream is followed and reported
- [ ] Numbers are preserved, so a mirrored `#123` is `#123`
- [ ] A comment from an unlinked GitHub account is attributed to nobody local
- [ ] A failed sync leaves the previous state intact and readable, rather than a half-updated
      repository
