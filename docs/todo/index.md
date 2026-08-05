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
| [00 - Bootstrap](./00-bootstrap.md) | Scaffold, Postgres, tooling, agent setup | Done, 5 deferred (27/32) |
| [01 - Foundation](./01-foundation.md) | Users, organizations, teams, tokens, keys | In progress (22/57) |
| [02 - Git hosting](./02-git-hosting.md) | Repositories on disk, smart HTTP, code browsing | In progress (75/92) |
| [03 - Issues](./03-issues.md) | Issues, comments, labels, milestones, markdown | Done (37/37) |
| [04 - Reviews](./04-reviews.md) | Pull requests, reviews, diffs, merging, stacks | In progress (49/85) |
| [05 - Notifications and webhooks](./05-notifications-webhooks.md) | Delivery, subscriptions, webhooks | In progress (21/51) |
| [06 - Search and explore](./06-search-explore.md) | Indexing, search, discovery | Started (1/20) |
| [07 - Marketing and docs](./07-marketing-docs.md) | Landing page, documentation, self-hosting guide | In progress (21/45) |
| [08 - Migration](./08-migration.md) | Importing from GitHub and other forges | Not started (0/16) |
| [09 - Checks and CI](./09-checks-ci.md) | Checks, durable workflows, runner providers, deployments | Started (3/94) |
| [10 - Federation](./10-federation.md) | Research: ActivityPub / ForgeFed versus AT Protocol | Research (0/13) |
| [11 - Self-hosting and operations](./11-self-hosting-deploy.md) | Deployment, backups, upgrades, ops | Started (1/44) |
| [12 - The API and agents](./12-api-and-agents.md) | API parity, machine accounts, MCP, the CLI | Not started (0/30) |
| [13 - Mirroring](./13-mirroring.md) | Mirror GitHub repositories, keep pushing upstream | In progress (24/44) |
| [14 - The diff engine](./14-diff-engine.md) | Streaming, virtualization, worker highlighting, the perf bar | In progress (57/157) |

Phase 14 was written after reading Pierre's [DiffsHub](https://diffshub.com) and the Apache 2.0
packages behind it. It is the only phase with a named competitor, because the diff surface is the one
place where somebody else has already published the number we have to beat. It carries the diff
engine work that phase 4 refers to but does not describe.

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

`deleteWhereIn` and `updateWhereIn` in `app/Actions/Support/rows.ts` are the workaround, in one
place so it is worked around once rather than remembered. They go away when the builder renders
`IN` on writes.

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

- **A package registry.** Out of scope until the forge itself is good. When it is reconsidered, its
  permissions (`packages:read`, `packages:write`) are fine-grained token permissions from the first
  commit. See the rule in [phase 1](./01-foundation.md#access-tokens): there is no second token type
  to fall back to, which is exactly the trap this project is avoiding.
- **A wiki.** Repository markdown files cover most of the need.
- **Projects and boards.** Issues with labels and milestones first.
- **In-browser editing.** A pull request from the browser is a phase 4 concern at the earliest.
- **An unreviewed hosted CI execution plane.** Phase 9 starts with status and check APIs, then a
  provider-neutral workflow control plane that self-hosted or external runners can consume. Running
  other people's code on instance-managed infrastructure remains a separate security project and
  does not begin until its threat model, isolation boundary, secret flow, cache policy, and quotas
  pass review.
