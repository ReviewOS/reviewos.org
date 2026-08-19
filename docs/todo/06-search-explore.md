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

- [x] `app/Actions/Explore/TrendingAction.ts` - stars gained over a window, not total stars, so new
      work can surface

  `ExploreAction`, one endpoint rather than four - the page asks one question
  and four endpoints would be four places the public-only rule has to be right.

  Gained rather than total is the whole reason it exists: a list by total stars
  is the same list every week and shows nobody anything they did not know.
  Counted from `stars.created_at`, which is what makes a window possible at all
  and the reason that table keeps a row per star rather than a counter. The
  window is bounded at ninety days, because "trending over three years" is the
  all-time list wearing a disguise.
- [x] Browse by topic and by language

  Both, as filters on the same page and endpoint, so a filtered view is a URL
  somebody can link to. Ordered differently on purpose: by topic is by stars,
  by language is by *how much of that language the repository contains* - the
  question "what Rust is on this instance" is better answered by the Rust
  repositories than by the popular ones with a build script in it.
- [x] Recently active repositories

  From `pushed_at`, which both the push path and the mirror sync write. Returned
  *alongside* trending rather than as a fallback for it: on a young instance
  nothing has gained a star this week, and a page that quietly showed recently
  active under a heading saying "trending" would be lying about what the
  instance knows. Two lists, two empty states, and the page decides what to
  hide.
- [x] A Discover feed of public activity, with trending and recently active repositories beside it

  The event's recorded visibility and the repository's current visibility both
  matter. The first stops a repository made public today from exposing events
  written while it was private. The second stops a repository made private
  today from remaining advertised on a page that links somewhere the reader can
  no longer open. Keyset pagination uses the event id, so later pages cost the
  same as the first.
- [x] `resources/views/explore.stx`

  Server-rendered from the same reads the endpoint calls, for the reason
  `search.stx` gives: a page that reimplemented the visibility filter would be
  a second answer to "who may see this", and only one of the two would ever be
  audited. Here it matters most - explore is the surface where a mistake is a
  listing rather than a leak to one person, so the test asserts the private
  repository is absent from the HTML as well as from the JSON.

  Checked in a browser in both themes, which is how the missing half was found:
  the first version referenced a dozen `explore-*` classes that did not exist
  and rendered as a stack of unstyled text. Every colour and radius is a theme
  variable now, so the dark rendering is right rather than accidentally
  readable.
- [x] Language detection per repository from file extensions, stored as a breakdown

  A breakdown table rather than a `language` column, which makes "browse by
  language" a join rather than a scan and stops a repository with a frontend and
  a backend having to pick one.

  **Bytes, not files.** Forty small YAML files and one large Go program is a Go
  repository, and counting files says it is YAML - configuration and lock files
  outnumber source files in most modern projects. Vendored trees, build output
  and lock files are excluded, and unidentified files leave the numerator rather
  than being pooled, so the percentages describe the code that *is* identified
  and add to a hundred. "43% Other" is not information anybody can act on.

  Measured by `MeasureLanguagesJob` on the same push that queues the reindex,
  from one `git ls-tree -r --long` rather than a walk that asks git per object -
  on a repository with forty thousand files that is forty thousand processes.

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
- [x] Instance-wide code search only after the above, and only with a decision recorded here about
      the index

  **Built: a trigram index that narrows, with `git grep` still deciding.**
  `GET /api/search/code`, `buddy search:index`, and a shard rebuilt per
  repository on push.

  The decision the box asked for, and it is the one that makes the rest safe:
  **the index never answers, it only excludes.** For each repository the shard
  says which files *could* contain the query; the matches themselves come from
  `git grep` against the tree at the ref, the same way in-repository search
  already works. So a result is the code as it is now rather than as it was when
  an indexer last ran, and the index is allowed to be wrong in exactly one
  direction - offering a file that turns out not to match costs a grep, and
  withholding one that does is a result nobody sees. Everything is arranged
  against the second: a query the index cannot narrow (too short, an
  alternation, a quantifier over a literal) searches everything rather than
  narrowing wrongly.

  **Staleness is bounded rather than assumed away.** A shard records the commit
  it was built from; when the ref has moved, every path changed between the two
  joins the candidate set whatever the index says, so a file written since the
  last build is still found. When that commit is gone - a force-push, history
  rewritten - the repository is searched in full. The index can be out of date;
  it cannot be wrong.

  **The measurements that shaped it**, taken on this repository (3,769 files):

  | | |
  |---|---|
  | building a shard | 1.3s |
  | shard on disk | 10 MB |
  | narrowing a query | ~16ms |
  | grep of the narrowed candidates | ~12ms |
  | a term nothing holds | 0 candidates, **no git process at all** |

  Two things had to change to get there, and both are the kind of bug this
  index must not have. Reading `cat-file --batch` by slicing a *string* at
  git's byte offsets desynchronised on the first non-ASCII character and
  indexed 33 files of 3,949 while reporting success - a search that quietly
  cannot find things. And decoding a whole shard to answer a question about
  twenty trigrams cost 150ms per repository, which across a thousand of them is
  two and a half minutes before a line is searched: every shard now opens with a
  32KB bitmap of the trigrams it holds, so a repository that cannot match is
  dismissed by reading the head of a file, and only the survivors are opened.

  What is left for a large instance is written down rather than guessed at: the
  posting lines are scanned rather than seeked, so opening a surviving shard is
  linear in its size. An offset table would fix that and is a format that has to
  be rebuilt when it is wrong - worth doing when somebody has an instance where
  it matters, not before.
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
