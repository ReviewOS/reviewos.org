# Roadmap

Every phase below is a checklist. A box is ticked when the work is done, verified, and committed,
and it gets ticked **in the same commit as the work**. An unticked box that is actually finished is
worse than no roadmap at all, because the next person redoes it.

Phases are ordered by dependency, not by importance. Phase 4 is the reason this project exists;
it needs phases 1 and 2 underneath it first.

## Phases

The counts are boxes ticked over boxes written. They move when the work lands and when the list
grows, so a phase getting *longer* while it is worked on is normal and honest.

| Phase | What it covers | State |
|---|---|---|
| [00 - Bootstrap](./00-bootstrap.md) | Scaffold, Postgres, tooling, agent setup | Done (32/32) |
| [01 - Foundation](./01-foundation.md) | Users, organizations, teams, tokens, keys | Done (65/65) |
| [02 - Git hosting](./02-git-hosting.md) | Repositories on disk, smart HTTP, code browsing | In progress (120/121) |
| [03 - Issues](./03-issues.md) | Issues, comments, labels, milestones, markdown | Done (37/37) |
| [04 - Reviews](./04-reviews.md) | Pull requests, reviews, diffs, merging, stacks | Done (95/95) |
| [05 - Notifications and webhooks](./05-notifications-webhooks.md) | Delivery, subscriptions, webhooks | Done (51/51) |
| [06 - Search and explore](./06-search-explore.md) | Indexing, search, discovery | Started (8/20) |
| [07 - Marketing and docs](./07-marketing-docs.md) | Landing page, documentation, self-hosting guide | In progress (21/45) |
| [08 - Migration](./08-migration.md) | Importing from GitHub and other forges | Not started (0/16) |
| [09 - Checks and CI](./09-checks-ci.md) | Checks, durable execution, runner providers, deployments | Started (3/120) |
| [10 - Federation](./10-federation.md) | Research: ActivityPub / ForgeFed versus AT Protocol | Research (0/13) |
| [11 - Self-hosting and operations](./11-self-hosting-deploy.md) | Deployment, backups, upgrades, ops | Started (1/44) |
| [12 - The API and agents](./12-api-and-agents.md) | API parity, machine accounts, MCP, the CLI | Started (18/30) |
| [13 - Mirroring](./13-mirroring.md) | Mirror GitHub repositories, keep pushing upstream | In progress (38/44) |
| [14 - The diff engine](./14-diff-engine.md) | Streaming, virtualization, worker highlighting, the perf bar | In progress (135/169) |
| [15 - Pipelines](./15-pipelines.md) | Actions compatibility, step model, runner fleet, test intelligence | Not started (0/189) |

Phase 14 was written after reading Pierre's [DiffsHub](https://diffshub.com) and the Apache 2.0
packages behind it. It carries the diff engine work that phase 4 refers to but does not describe,
and it names a competitor because the diff surface is the one place where somebody else has already
published the number we have to beat.

Phase 15 has two named competitors, and they are competing for different things.
**GitHub Actions is the familiarity target**: almost everyone arriving already has workflow files
that work and no appetite for learning a second CI language to leave GitHub, so the canonical format
is Actions-compatible YAML and the acceptance test is that a copied `.github/workflows` directory
goes green with no edits. **[Buildkite](https://buildkite.com/home/) is the capability target**: it
is what Actions turns into when a company outgrows it, and their architecture is ours, in that they
run the control plane while you run the compute on your own machines with your own secrets. So the
expensive, dangerous half of what Buildkite sells is the half phase 9 has deliberately gated behind
a security review, and the half that is actually hard to copy is a control plane, an API, and a set
of screens.

Actions syntax on the front, Buildkite-grade engine underneath. Gitea and Forgejo both proved the
compatible-format half works; the places they stop, concurrency groups, schedules, environment
protection, and test intelligence, are exactly the Buildkite capabilities phase 15 carries. Phase 9
owns the machinery; phase 15 is the product it has to add up to, including the one thing neither
competitor can price against us: a check result, an annotation, and a flaky test verdict landing on
the diff rather than in another tab.

Phase 9 has a third reference, [Cloudflare's CI Workflows](https://blog.cloudflare.com/ci-workflows/),
and it supplies the substrate rather than the surface: durable execution, where a run survives the
death of whatever was executing it and restarts from a named step without repeating completed work.
The question that had been left open there is now answered. Cloudflare evaluates workflow code in
their control plane because their control plane is a Workers isolate and running untrusted code is
what it is for; ours holds the database, the session keys, and every bare repository on disk, so
**a code-first workflow runs as an orchestrator job on a runner and its step calls are API calls
back**, journaled by the control plane so a killed orchestrator replays rather than re-runs. Static
YAML needs no orchestrator at all. Both normalize to the same rows, which is the property that keeps
one product from becoming two.

Several later phases have code in them too. Work went depth-first through vertical slices (identity,
a repository on disk, an issue, a pull request, a notification, checks, operations, mirroring, and
the diff engine) rather than finishing one phase before opening the next. That was the right order
for proving the review screen, and it is the reason the counts are partial across the roadmap.

Phase 3 is done. The last two boxes were the same box - reading a commit message - and closing them
meant building phase 2's push pipeline: a pre-receive hook that can still refuse, a post-receive hook
that reports what landed, and `ProcessPushJob` behind them. So `fixes #12` in a commit now closes
issue 12, a commit that mentions an issue leaves a line on it, and a force push at a protected branch
is refused with a message git prints legibly.

## The silent failure that costs the most

Worth stating once, because three ticked boxes turned out to be untrue for the same reason and the
next one will be too.

**stx server scripts have no `query`.** `params` is bound, `db` is bound, `query` is not - it comes
from `useRoute()`. Reaching for a bare `query` throws, stx catches the throw and falls back to
static extraction, and the page renders with *every variable undefined*: no error in the log, no
stack trace, no failed request. The symptom is a page showing its not-found branch or its empty
state, which is indistinguishable from there being nothing to show.

That is how the issue-template chooser, the milestone state filter, and the `?state=` filter on both
list views all shipped ticked and none of them ever ran. `STX_DEBUG=1` prints the real cause; it is
worth running the dev server with it on.

**And `useRoute()` was only half the answer until stx 0.2.159.** It read a raw search string that
only the dev server sets, so on the boot a production server and the e2e suite both use it returned
`{}` - eleven pages here were reading a query string that was always empty, and none of them looked
broken, because a page keyed on `?token=` renders its no-token branch, which is a real branch. Use
`useRoute().query`; it now reads whichever shape the host supplied.

## A signed-in browser is not a signed-in test client

Two bugs, found by opening a page in a browser with a session rather than by running anything, and
both with the same shape: the code worked for everybody who could not use the feature and failed for
everybody who could. Written up in [phase 14](./14-diff-engine.md); the general lesson is the point
here.

**A `fetch` carries no CSRF token.** The router checks a double-submit token on every non-safe
method, and `CsrfField.stx` puts one in every form. A `fetch` sends neither the header nor the field
unless told to, so a write from a script is refused with 403 - *but only for a reader with a
session*, because a browser with no cookie has nothing to mismatch. It passes signed out.

**`currentUser` never looked at a cookie.** It resolved `request.user()` and a bearer token, and a
browser sends neither: a page signs somebody in with a cookie and a `fetch` from it carries only
that. So every endpoint outside the auth middleware saw a stranger, and answered a signed-in reader
as though nobody were there, with a 200.

What they have in common is the credential. **Every test in this repository authenticates with a
token, and a token works whether or not either bug is present.** A suite that only ever holds a
bearer cannot see a class of failure that only exists for cookie holders, which is every human being
using the product. Ask what the *browser* sends, not what the client library can be made to send.

## Three bugs the test suite could not see, all the same shape

Written up because a fourth is coming and it will look like this one.

**Every write in this suite authenticates with a bearer token, and a bearer bypasses CSRF by
design.** So the suite exercises a request no human ever makes, and anything that only breaks for a
cookie-holding browser passes. The two bugs already recorded below - a `fetch` carrying no CSRF
token, and `currentUser` never looking at a cookie - are the first two instances.

The third: **every form in the product was refused for a first-time visitor**, for eight months, with
a hundred passing tests. The router seeded the CSRF cookie only on the route-handler pipeline, which
a file-based view does not take, and `CsrfField` read its token from `__stxServeContext`, which is
undefined under `route.serve()`. Nobody could open an issue, create a repository, comment or sign
up. Written up in [phase 1](./01-foundation.md); fixed upstream in Stacks 0.70.312 and here.

All three were found by opening a page, not by running anything. The rule that would have caught all
three: **a test that authenticates differently from a person is not testing what a person does.**
`tests/e2e/csrf-forms.test.ts` is the one that behaves like a browser - GET the page, keep the
cookie, read the token out of the HTML, post the form - and it is worth adding to rather than
working around.

A fourth has since joined them, and it is the same shape one level down. `useRoute().query` was
always `{}` on the boot a production server and the e2e suite both use: it read a raw search string
that only the dev server sets, while bun-router's file-based `serve()` supplies the query already
parsed. **Eleven pages here were reading a query string that was always empty**, and none of them
looked broken - a page keyed on `?token=` rendered its no-token branch, which is a real branch that
reads as correct. Fixed in stx 0.2.159.

The common thread across all four is worth naming, because it will produce a fifth: **two hosts
render stx in this product, and only one of them is the one anybody looks at.** `buddy dev` goes
through bun-plugin-stx; everything else - a production boot, the e2e suite - goes through
`route.serve()`, and the second is where the request context, the CSRF cookie, the response helpers
and now the query string all turned out to be missing. When something works in development and a
test cannot see it, that difference is the first place to look.

## The tests all used the cases where the wrong answer is right

Every review comment left on an added line was marked outdated the moment it was written, for as
long as review threads have existed here. Commenting on the code being *proposed* is the most
ordinary thing a reviewer does.

The cause was two functions that look interchangeable and are not. `reanchor` maps a line from the
old side of a diff to the new side, and its own doc comment says which diff it wants: the one from
the commit a thread was written against to the current head. It was being handed the base-to-head
diff instead - the one on screen, where a thread's line is already a position rather than something
to map. Written up in [phase 4](./04-reviews.md).

What kept it hidden is worth more than the bug. There were four tests on the anchoring path and all
four passed, because **every one of them used a context line or the left side** - the two cases
where mapping a new-side number through an old-side mapping happens to give the right answer. The
one case that mattered, and the one every real review is made of, was the one nobody wrote.

So: when a function takes "a diff" and there is more than one diff it could mean, the tests have to
include the case where the two answers differ. A test suite made of the inputs where two
implementations agree cannot tell you which one you have.

There are now three diffs in play and each one answers a different question, which is worth naming
because the wrong choice is silent every time:

| | |
|---|---|
| `base...head` | what this branch is proposing. The diff on screen. |
| `original_commit_sha..head` | what happened to the code since a thread was written. Two dots: a rebase moves the merge base, so three would report that nothing changed. |
| each head against its own merge base, compared | what moved since a reviewer last looked. See "since I last looked" in [phase 4](./04-reviews.md). |

## Ask which one, not whether it worked

The worst bug found so far passed every check anybody would think to run.
`upload-pack` and `receive-pack` take the repository as their own positional
argument and ignore `--git-dir`, and the wire-protocol routes passed `.` - so
every request operated on the server process's working directory rather than on
the repository in the URL.

`git clone` succeeded. It checked out a real tree with real files. `git push`
reported a new branch. The permission checks were correct and passed - on the
repository that was *asked for*, while a different one was handed over. The ref
advertisement even matched, byte for byte, what the same command produced on the
command line, because the command line was wrong in the same way.

What it actually did: served the forge's own source for any URL including
private repositories nobody had access to, and wrote pushed refs into the
application's checkout.

The question that found it was not "did the clone work" but **"which repository
did it clone"** - and the answer was visible in one `rev-parse`. Verification
that only asks whether an operation succeeded will miss every bug of this shape,
and this will not be the last one.

## The other silent failure: the query builder drops what it cannot express

Same shape, different layer, and this one had been wrong since the first counter was written.

**`.set(eb => ...)` emits an empty `SET`.** Every counter in the product was maintained like this:

```ts
.set(eb => ({ open_issues_count: eb('open_issues_count', '+', 1) }))
```

which compiles to `UPDATE "repositories" SET  WHERE "id" = $1`. Postgres rejects it, the error is
swallowed by the `try` around it or surfaces as a failed request nobody connected to a counter, and
**not one counter had ever moved**: every repository said `0 open issues` from the day it was
created, and every issue said `0 comments`. Seven call sites, all of them written the same way,
none of them working.

It is the `where(eb => ...)` defect again - the one `ListIssuesAction` is built around avoiding -
and it will be some other method next time. **Check the SQL, not the shape of the call.**
`(query as any).toSQL()` is the fastest way to find out whether a builder understood you.

The counters are recomputed from the rows they count now (`app/Actions/Repo/counters.ts`) rather
than adjusted. It costs one indexed `COUNT` per mutation and it is correct under concurrency,
self-healing on the values that are already wrong, and impossible to drift.

**`.where(column, 'in', ids)` renders `in $1` on a write.** The third one, found the same way. On a
`SELECT` it is correct - `WHERE repository_id IN ($1, $2, $3)` - because the select path expands the
array itself. On an `UPDATE` or a `DELETE` the operator is spliced in with a single placeholder
after it:

```
DELETE FROM "issue_labels" WHERE "issue_id" in $1
```

Postgres answers `syntax error at or near "$1"`. So bulk close, bulk label, bulk unlabel and bulk
milestone had never done anything, and neither had closing an issue by merging a pull request.

What makes this one nastier than the last is that the *same call, spelled the same way, works* - as
long as it is a read. The pattern looks proven by a dozen working call sites, and it is, for reads.

**Fixed at the source in bun-query-builder 0.2.24**, on both the three-argument and array forms of
`where`, on updates and deletes, numbering placeholders after whatever `SET` already bound. The same
release stops `deleteFrom` splicing an unchecked operator into its statement text - `updateTable`
had always asserted against the allowed set and its sibling had not, which is an injection point in
the one statement that cannot be walked back.

`deleteWhereIn` and `updateWhereIn` in `app/Actions/Support/rows.ts` were the workaround and now go
through the builder like everything else. They still exist, for two reasons that are not defects:
they chunk at `IN_CHUNK` so no call site has to remember a driver's parameter ceiling, and
`deleteWhereIn` returns rows actually deleted via `RETURNING` rather than the number of ids it was
asked about.

**`.where(column, 'is', null)` binds the null.** The fourth of the family, and the cheapest to
avoid: it emits `"responded_at" is $2` and Postgres answers `syntax error at or near "$2"`. Use
`whereNull` and `whereNotNull`, which render it properly - `MirrorMetadataSyncJob` has a note about
the second and it is the same answer for both.

**`whereNull` does not exist on the *update* builder.** Which is the fifth, and the most expensive
so far: it is why the database queue driver has never reserved a job. `@stacksjs/queue` claims a row
with `.updateTable('jobs').set(...).where('id','=',id).whereNull('reserved_at')`, an optimistic lock
that is exactly the right shape, and the method is simply not there - present on selects, absent on
updates, so it reads as correct everywhere it is written. Every reserve throws a `TypeError` into a
bare `catch { continue }` and the worker polls forever reporting "Listening for jobs...". Written up
in [phase 5](./05-notifications-webhooks.md).

**Fixed at the source in bun-query-builder 0.2.23**, on updates and deletes, rendering the predicate
rather than parameterising it and continuing an existing `WHERE` with `AND`. `@stacksjs/queue` also
no longer swallows a failed reserve: it logs, rate-limited, so the next one announces itself. Both
released and pulled in; the database driver reserves and runs.

The lesson generalises past this builder. **Four of these five are silent, and the difference is
never the defect - it is who is catching.** The empty `SET` and the `IN`-on-a-write surfaced as
Postgres errors that something swallowed; `is null` announced itself only because the one call site
happened to sit outside a `try`; and this one is inside a `catch` with no logging at all, which is
why "the jobs table exists" was true for months while nothing in it ever ran. When a query builder
is involved, check the SQL *and* check what happens to the exception.

This one announced itself, and only by luck. The call was outside a `try`; inside one - which is
where three of the four above were found - it would have returned an empty result and the feature
built on it would have quietly done nothing. That is the pattern, across all four: **the builder
does not refuse what it cannot express, it emits something Postgres refuses**, and whether anybody
notices depends entirely on who is catching.

## How work is shaped

Stacks resolves a feature in a fixed order, and the checklists follow it:

**model → migration → action → route → view → test**

Concretely, for anything with data behind it:

1. Define or change the model in `app/Models/`. Every attribute gets `validation.rule` and a
   realistic `factory`, and the model gets `useSeeder`, so seeding keeps working without manual
   wiring.
2. Generate the migration with `./buddy generate:migrations` and review the SQL. Never hand-write
   it, and commit the regenerated model snapshot alongside it.
3. Write the action in `app/Actions/<Domain>/`, one per endpoint.
4. Register the route in `routes/`.
5. Build the view in `resources/views/` (file-based, no route registration) with components in
   `resources/components/`.
6. Add tests under `tests/`.

## The migration workflow

`./buddy generate:migrations` then `./buddy migrate` is the loop, and both halves
now behave. Getting there took four fixes, all upstream, because every one of
them would have hit any other project the same way:

- **A foreign key against the wrong table.** `issues.author_id` is declared
  `belongsTo: [{ model: 'User', foreignKey: 'author_id' }]` and came out pointing at `authors`, a
  CMS table this project does not use. Applying it would have rejected every issue insert. Fixed in
  bun-query-builder; the framework had been pinned to `^0.1.63`, a range that could never resolve to
  the 0.2 line where it was fixed.
- **Foreign keys on polymorphic columns.** `taggable_models.taggable_id` was constrained against
  whatever `taggable_type` happened to default to, so tagging a post worked and tagging anything
  else was rejected. The main loop already knew better; the inline pivot builder did not
  (bun-query-builder 0.2.3).
- **Enum ALTERs silently dropped.** 69 statements a run were discarded with a warning calling
  itself a generator bug. The column kept whatever it had, so the model change quietly did not
  happen and the next diff proposed the same thing again, forever. The values are in the plan, so
  the type is now created ahead of the ALTER that wants it (stacks 0.70.242).
- **`CREATE TYPE` is not re-runnable.** It has no `IF NOT EXISTS`, so a corpus containing one could
  only be applied to a database that had never seen it. Any gap between ledger and schema - an
  interrupted run, a restored dump, a database built before the ledger existed - stopped `migrate`
  dead, naming a type that was already exactly right, with `migrate:fresh` the only way out. Now
  wrapped in a guard that catches the duplicate. The statement splitter had to learn dollar quoting
  for that guard to survive it, and while it was open it also learned that a `;` or a `--` inside a
  string is data rather than punctuation.

- **The guard made `CREATE TYPE` meaningless.** Adding a value to an enum in a model regenerates the
  `CREATE TYPE` with the full new set, and on a database that already has the type the guard above
  swallowed it - so the value never arrived, every insert using it failed against a column that
  would not take it, and the next diff proposed the same statement again. The silent-no-op loop the
  guard was written to end, moved one step along. `guardPostgresEnumTypes` now emits an
  `ALTER TYPE … ADD VALUE IF NOT EXISTS` per member alongside the guarded create, including for
  corpora that an earlier version already guarded. Found by adding one value to
  `TimelineEntry.kind`.

Two properties worth keeping true, because both were broken and neither is obvious:

- Running `generate:migrations` twice writes files once. The second run diffs against the snapshot
  the first one wrote, and finds nothing.
- Running `migrate` twice applies once. Nothing in a generated corpus fails because it has already
  been done.

## The in-house tools are not linked here

`node_modules/@stacksjs/*`, `pickier` and `bun-query-builder` are published copies in this checkout,
not symlinks into the local checkouts that [AGENTS.md](../../AGENTS.md) describes. So a fix made
upstream does not reach this app until it is released or `./buddy link:core --all` is run, and a
generated file may need the fixed statement added by hand in the meantime - migration
`0000000105-auto-misc.sql` carries one, with a comment saying so.

Two upstream fixes are waiting on that:

- **stacks** (`storage/framework/core/database`): the enum `ADD VALUE` fix above.
- **pickier**: an apostrophe in a comment inside a function body made `no-unused-vars` read the rest
  of the body as a string literal, so every parameter above it was reported as unused - and the
  autofix then offers to rename them to `_name` while the body still says `name`. Comments are now
  blanked before the scanners run (`maskCommentText`). Until pickier is picked up here, one comment
  in `app/Actions/Markdown/render.ts` is written without an apostrophe, and says why.

## Deliberately not doing yet

Naming these keeps them from being re-proposed every few weeks:

- **A package registry.** Out of scope until the forge itself is good, and it stays out of scope even
  though Buildkite sells one and [phase 15](./15-pipelines.md) counts it as a real gap
  against them. When it is reconsidered, its permissions (`packages:read`, `packages:write`) are
  fine-grained token permissions from the first commit. See the rule in
  [phase 1](./01-foundation.md#access-tokens): there is no second token type to fall back to, which
  is exactly the trap this project is avoiding.
- **A wiki.** Repository markdown files cover most of the need.
- **Projects and boards.** Issues with labels and milestones first.
- **In-browser editing.** A pull request from the browser is a phase 4 concern at the earliest.
- **An unreviewed hosted CI execution plane.** Phase 9 starts with status and check APIs, then a
  provider-neutral workflow control plane that self-hosted or external runners can consume. Running
  other people's code on instance-managed infrastructure remains a separate security project and
  does not begin until its threat model, isolation boundary, secret flow, cache policy, and quotas
  pass review. Everything in [phase 15](./15-pipelines.md) is deliberately written to be
  useful with only self-hosted runners, so competing with Buildkite never becomes the argument for
  skipping that review.
