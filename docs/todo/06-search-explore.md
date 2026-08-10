# 06 - Search and explore

Finding things: within a repository, across an instance, and discovering what exists at all.

Stacks ships drivers for several engines; this instance runs **Typesense**, chosen in
`config/search-engine.ts` for the reason written there - one binary and no JVM under it, which is
what lets search be on by default on somebody's own box. Code search is a different problem and is
scoped separately below.

That choice had never reached the two files that make it real. `.env.example` still named
`meilisearch` and its host and key, and `deps.yaml` - which is generated from `config/deps.ts` *and*
from sniffing `.env` - never carried `typesense.org`, so a fresh checkout installed no search node
at all and the five search e2e tests failed against nothing. They skip themselves now when no node
is reachable, the way every other e2e here skips when its dependency is missing, because a stack
trace out of the driver reads like the product is broken rather than like the machine is missing a
service.

One caveat worth knowing before debugging a port: `pantry start typesense --port 8208`, which
`config/deps.ts` runs at setup, does **not** move the port on pantry 0.10.3 - the service still
binds Typesense's default 8108, and `pantry inspect` confirms it. The env values above say 8108
because that is what actually listens.

## Indexing

- [x] `useSearch` on `Repository` (name, description, topics, owner handle), `Issue` (title, body,
      labels), `PullRequest`, and `User` (handle, name)
- [x] `app/Jobs/IndexRepositoryJob.ts` on the `search` queue, triggered on create, update, and push
- [x] Reindex command for a full rebuild, and for recovering after an index loss
- [x] Visibility is enforced at query time from the current user's permissions. Never rely on the
      index alone to keep private repositories out of results.
- [x] Tests specifically for the leak case: a private repository must not appear for a user without
      access, including through issue and comment results

## Search

- [x] `app/Actions/Search/SearchAction.ts` with scopes: repositories, issues, pull requests, users
- [x] Qualifiers people already know: `is:open`, `is:merged`, `author:`, `assignee:`, `label:`,
      `milestone:`, `repo:`, `org:`, `language:`, `created:`, `updated:`
- [x] A real parser for the query syntax, not a regex, so quoting and negation behave
- [x] Result ranking that puts recently active things first
- [x] `resources/views/search.stx` with tabs per scope

## Explore

- [ ] `app/Actions/Explore/TrendingAction.ts` - stars gained over a window, not total stars, so new
      work can surface
- [ ] Browse by topic and by language
- [ ] Recently active repositories
- [ ] `resources/views/explore.stx`
- [ ] Language detection per repository from file extensions, stored as a breakdown

## Code search

Deliberately separate. This is where forges either invest heavily or ship something disappointing.

- [ ] Decide the approach before building: `git grep` per repository is cheap and exact but does not
      scale across an instance; a trigram index scales but is a substantial subsystem
- [ ] Start with in-repository search using `git grep` against a ref, which is genuinely useful and
      cheap
- [ ] Instance-wide code search only after the above, and only with a decision recorded here about
      the index
- [ ] Regex support, path filters, and language filters
- [ ] Results show surrounding context and link to the exact line in the blob view
