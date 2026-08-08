# 06 - Search and explore

Finding things: within a repository, across an instance, and discovering what exists at all.

Stacks ships a Meilisearch driver, which covers repositories, issues, and users well. Code search is
a different problem and is scoped separately below.

## Indexing

- [ ] `useSearch` on `Repository` (name, description, topics, owner handle), `Issue` (title, body,
      labels), `PullRequest`, and `User` (handle, name)
- [x] `app/Jobs/IndexRepositoryJob.ts` on the `search` queue, triggered on create, update, and push
- [ ] Reindex command for a full rebuild, and for recovering after an index loss
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
- [ ] `resources/views/search.stx` with tabs per scope

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
