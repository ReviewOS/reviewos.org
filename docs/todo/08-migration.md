# 08 - Migration

Getting existing work in. Nobody adopts a forge they cannot move to, and the quality of the importer
decides whether an evaluation ends in a migration or a shrug.

## Importing from GitHub

- [ ] `app/Jobs/ImportRepositoryJob.ts` on the `git` queue, resumable, because these take a long time
      and will be interrupted
- [ ] Git data first via `git clone --mirror`, so the repository is usable before metadata arrives
- [ ] Issues with their comments, labels, milestones, and state
- [ ] Pull requests with their reviews and review threads, anchored to the same lines. Review
      threads are the part other importers drop; keeping them is most of the value here.
- [ ] Releases and their assets
- [ ] Map GitHub users to local accounts where handles or emails match, and record an unmapped
      attribution otherwise rather than silently reassigning authorship
- [ ] Preserve issue and pull request numbers. A repository whose `#123` no longer resolves has lost
      every cross reference in its own history.
- [ ] Rewrite cross references in imported bodies to point at the local equivalents
- [ ] Respect the API rate limit, with backoff and clear progress rather than an opaque stall
- [ ] Progress in the interface: what has been imported, what remains, what failed and why
- [ ] Tests against a fixture repository covering each entity type

## Importing from other forges

- [ ] Gitea and Forgejo, which share an API shape
- [ ] GitLab
- [ ] Plain git URL import, with no metadata, for everything else

## Mirroring

- [ ] `app/Models/RepositoryMirror.ts`: `repository_id`, `direction` (pull, push), `remote_url`,
      credentials reference, `interval`, `last_synced_at`, `last_error`
- [ ] `app/Jobs/MirrorSyncJob.ts`, scheduled, with failures surfaced on the repository rather than
      only in logs
- [ ] Pull mirror: keep a copy of a repository hosted elsewhere
- [ ] Push mirror: keep a copy elsewhere in sync with this one, which is the low-risk way for
      someone to try this forge without committing to it

## Exporting

- [ ] Full export of a repository and its metadata as an archive
- [ ] Documented, stable export format, so leaving is possible. A forge that is hard to leave is a
      forge people are right to distrust.
