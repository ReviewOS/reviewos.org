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

- [x] Decide the approach before building: `git grep` per repository is cheap and exact but does not
      scale across an instance; a trigram index scales but is a substantial subsystem

  **Decided: `git grep`, per repository, and no index.** It reads the tree at a
  commit, so an answer is the code *as it is on that ref* rather than as it was
  when an indexer last ran - which for a review tool is the difference between
  an answer and a plausible one. The test proves it: a word committed only on a
  branch is not found on `main`.

  What it does not do is scale across an instance, and the fix for that is a
  trigram index: its own storage, its own staleness, its own failure modes. Not
  built, deliberately, and written down in `app/Actions/Browse/search.ts` rather
  than left implied - in-repository search is useful on its own, and shipping
  instance-wide search badly is how forges end up with code search everybody
  distrusts.
- [x] Start with in-repository search using `git grep` against a ref, which is genuinely useful and
      cheap

  `GET /api/repos/search`, through `browseContext` - so a repository somebody
  can clone is one they can search, and one they cannot is a 404 rather than a
  403. Search that leaked the *existence* of a private repository through a
  status code would be a worse hole than the search is a feature.

  Bounded three ways, each a real failure rather than a precaution: a ten-second
  timeout, because a pathological regex on a large repository runs for minutes
  and a request holding a process open that long is a denial of service somebody
  finds by accident; a result cap, because a one-character search matches every
  line in the repository; and a two-character minimum, because searching for `e`
  is not a search.
- [ ] Instance-wide code search only after the above, and only with a decision recorded here about
      the index
- [x] Regex support, path filters, and language filters

  **Literal by default**, which matters more than it sounds: somebody searching
  for `foo(bar)` or `a.b.c` means those characters, and a regex default turns the
  first into a group and the second into three wildcards - so the results are
  wrong in the way that looks like the code is not there.

  A language and a path narrow *together*: `git grep` treats multiple pathspecs
  as alternatives, so passing `src` and `*.ts` returns every TypeScript file in
  the repository plus every file under `src`, which is the opposite of narrowing.
  A magic pathspec arriving from a query string - `:(exclude)` and friends - is
  refused, because it should be a path rather than an instruction.

  A broken regex reports what git said. It is the commonest mistake and the one
  the person who typed it can fix in a second if told.
- [x] Results show surrounding context and link to the exact line in the blob view

  Both, and two details that only a real `git grep` reveals:

  - **It prefixes every path with the ref.** `git grep x main` prints
    `main:src/cart.ts:3:...`, because it reports a path inside a tree object
    rather than a working directory. Left on, every result path is wrong by a
    prefix and every link built from one is a 404 - and it only appears when a
    ref is passed, which is always here and never in the shell where somebody
    would notice.
  - **Its separators occur in the things they separate.** A path can contain a
    colon and code contains them constantly, so the output is split at the first
    separator pair with a line number between rather than at the first two -
    otherwise `src/a:b.ts:7:x` parses as a path of `src/a` and a line of `b.ts`,
    fails, and drops a genuine match.

  Context lines are attached to the side they belong to. `git grep --context`
  interleaves them and a leading line arrives *before* its match, so attached
  naively a result reads as though the code above it is below it - worse than no
  context, because it is confidently wrong.
