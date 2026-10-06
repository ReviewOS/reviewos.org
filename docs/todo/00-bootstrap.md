# 00 - Bootstrap

Getting the application to exist, run, and talk to a database. Complete.

Several items here were framework or tooling bugs rather than application work. They are recorded
because the fixes live in other repositories, and because anyone reproducing this setup on a clean
machine benefits from knowing what was wrong.

## Application

- [x] Scaffold with `buddy new` into the existing repository
- [x] Package-based layout: no `storage/framework/core`, every `@stacksjs/*` resolved from npm
- [x] Generate `APP_KEY` and drop the template's undecryptable encrypted env files
- [x] Name the application: `package.json`, `config/app.ts`, README, MIT license
- [x] Point `lint`, `typecheck`, and `test` scripts at the buddy commands
- [x] Disable the commerce, cms, marketing, and monitoring feature bundles
- [x] Write `AGENTS.md`: domain vocabulary, git storage layout, framework sync-back rule
- [x] `./buddy setup:ai claude` for the skill set and launch config

## Database

- [x] Switch `DB_CONNECTION` to postgres in `.env` and `.env.example`
- [x] `DB_USERNAME=postgres`, the only role pantry's cluster has
- [x] Regenerate the migration corpus for Postgres (`./buddy migrate:regenerate postgres`)
- [x] Remove the stale SQLite model snapshot so the dialect guard passes
- [x] `./buddy migrate` applies cleanly: 82 tables
- [x] `./buddy seed` runs without errors
- [x] Database is created automatically from `.env` by pantry, not by hand

## Environment

- [x] `deps.yaml` generated from `config/deps.ts` plus `.env`, installing Postgres 17 and Bun 1.3.14
- [x] PostgreSQL starts as a pantry service before anything tries to connect
- [x] Link the local Stacks checkout with `./buddy link:core --all`

## Upstream fixes this required

Each one is committed and pushed in the repository named.

- [x] **stacks** - `buddy new` refused any existing directory, so cloning a repository first and
      scaffolding into it was impossible. It now accepts an empty directory, or one holding only
      `.git`, and skips `git init` when a repository is already there.
- [x] **stacks** - `buddy new` now resolves the framework from npm by default rather than vendoring
      2,000 files into the first commit. `--with-core` opts back in.
- [x] **stacks** - `buddy setup` installed every database engine rather than the one `DB_CONNECTION`
      names, and emitted no services section, so PostgreSQL was installed but never started and its
      own database creation failed with a connection refused.
- [x] **stacks** - The query log columns hold whole SQL statements and stack traces but were
      `varchar(255)`. SQLite never minded; Postgres rejected every insert.
- [x] **stacks** - Query logging recorded the literal string `[object Promise]` for every statement,
      which also made the N+1 detector report `[OBJECT PROMISE]` as the repeating query shape.
- [x] **stacks** - A 13 MB packed tarball was committed at the repository root and shipped into
      every scaffolded project.
- [x] **pantry** - Two of the four `initdb` call sites omitted `--username=postgres`, so whichever
      one created the cluster decided its superuser. Database creation then failed with
      `role "postgres" does not exist` against pantry's own cluster.
- [x] **pantry** - Service units are per-project but the PostgreSQL data directory was global, so
      two projects on different majors destroyed each other's cluster in a loop, each backing up and
      re-initializing what the other had just built.
- [x] **pickier** - A function whose return type is written as an inline union
      (`): { ok: true, ... } | { ok: false, ... } {`) makes `no-unused-vars` report every parameter
      as unused, because the parser does not find the body. `transitionDraft` in
      `app/Actions/Pull/state.ts` is the case that found it, and `resolveExpiry` in
      `app/TokenScopes.ts` is the case that proved it recurs.

  Fixed upstream and verified against the published build: the rule scanned past the return type for
  a `{` and stopped at the first one following a completed brace pair, so the second member of the
  union was read as the body. The body then read as empty and `--fix` renamed every parameter to
  `_name` while the body kept referring to `name` - code that no longer compiles, which is what
  makes it worse than noise. `pickier@0.1.49`, with
  `test/rules/no-unused-vars-return-types.test.ts` pinning it.
- [x] **pickier** - `no-unused-vars` also missed a module-level `const` referenced before it is
      declared, which is ordinary and valid: the eight content constants in `SeedDemo.ts` were each
      reported as unused while being used. Also fixed in `0.1.49`.

  Both workarounds stay. Naming the union and moving the constants into `demo-content.ts` were
  better code independently of the linter, and reverting structure to prove a tool is fixed is how
  you end up doing it twice.
- [x] **bun-query-builder** - Enum type names are table-qualified, but only newly added columns were
      stamped with the qualified name, so altering an existing enum column referenced a type nothing
      creates. Migrating to Postgres died on the last file with `type "channel_type" does not exist`.
- [x] **bun-query-builder** - The seeder handed factories `@stacksjs/ts-faker` directly, and every
      factory in this ecosystem is written in the faker-js dialect: `helpers.arrayElement` threw,
      `string.alphanumeric(12)` silently returned one character, `datatype` and `location` did not
      exist. The compat layer now translates both ways and is exported as a type, so a factory
      written the normal way is neither a runtime error nor a type error. `0.2.29`.
- [x] **ts-validation** - The declaration emitter widened `EnumValidator.name` to `unknown`, so
      `schema.enum([...])` was not assignable to the `EnumValidatorType` this library exports and a
      framework's env config rejected values it validates happily at runtime. A `.d.ts` bug wearing
      a type error's clothes. `0.5.4`, with a type test.
- [x] **stacks** - `@stacksjs/faker` builds an enhanced faker - `datatype`, `location`,
      `helpers.arrayElement`, `catchPhrase` - and exported the *type* of the library underneath it.
      Every model factory in every Stacks application was therefore a type error against a type
      describing a different object: 116 of them here, 73 in the framework's own default models.
      Fixed in 0.70.371 along with the env config's enum type.
- [x] **stacks** - bunpress was pinned at `^0.1.18`, where `/search-index.json` does not exist, so
      every documentation site built on this framework had a search box that took a query and
      answered nothing. `0.70.370`.
- [x] **stacks** - `faker.datatype.boolean(0.2)` - the bare-probability form faker-js accepts, and
      the form the framework's own `ProductUnit` model uses - was a type error, and the one error
      `./buddy typecheck` reported here. It was fixed and tagged as 0.70.372, and that release could
      not publish: the `Releaser` job failed building `storage/framework/core/mobile`, which imports
      `craft-native/mobile` - a subpath the published `craft-native@0.0.55` did not export.

      **Closed by the 0.72 line, which carries the fix and publishes.** The probability form
      typechecks against the installed framework, and `app/Models/ReviewThread.ts` uses it rather
      than a bare `boolean()`: a factory that resolves a fifth of its threads is closer to a real
      repository than one that resolves half, and a use in the tree is what makes a regression here
      fail `./buddy typecheck` instead of going unnoticed until somebody writes the form again.

- [x] **bun-router** - Static files were served gzipped and nothing else was. Every response a route
      produced went out whole: 253 KB of HTML on this project's landing page, `Accept-Encoding`
      ignored, on every request from every visitor. Compression now happens once, where every
      response passes through, with the two rules that make it safe rather than merely smaller - a
      `Vary` on both branches, so a cache cannot hand a gzipped body to a client that did not ask,
      and the body **piped** rather than buffered, so a streamed response keeps streaming: this
      product's diff manifest still arrives a file at a time, now compressed.

      The first attempt used `Content-Length` to tell a buffered response from a stream, and Bun
      does not set one on a `Response` built from a string - so the guard skipped every
      server-rendered page, which is the entire case. Piping needs no length and covers both.
      Two follow-ups, both found by watching what the application served rather than by reading the
      code: with no length there was nothing to compare against the threshold, so a 356-byte
      `/api/health` was being gzipped into something larger - the body is now peeked up to the
      threshold and no further - and `text/event-stream` matched `text/*` and was eligible, which
      would have turned a live channel into one that arrives in clumps.

      `0.0.26`. Measured on the landing page: **252,661 bytes to 61,184 on the wire**, with
      `/api/health` untouched and the diff manifest still arriving a file at a time.

- [x] **The framework upgrade, 0.72.50 to 0.75.65**, with stx, bun-query-builder, ts-cloud,
      bun-router, ts-images, pickier, ts-pantry and better-dx moved with it. Not optional and not
      separable: stacks 0.75 requires `bun-query-builder ^0.3.5`, `@stacksjs/ts-cloud ^0.16.25` and
      `@stacksjs/bun-router ^0.1.21`, and all three were pinned to older majors in `overrides`, so a
      partial bump resolves to a set that cannot work. The `buddy-bot/update-stacks` branch is
      exactly that partial bump and should not be merged as it stands.

      **The 408 type errors a fresh checkout reported were stale generated declarations, not the
      version gap.** `node_modules` held 0.70.352 while the lockfile said 0.72.50, and
      `storage/framework/types` was generated in the 0.70 era. An install plus
      `buddy generate:types` took it to 2, and both of those were real: `config/pages.ts` and
      `config/publicdiff.ts` each compared a `string | undefined` env var against a boolean, so one
      clause of each was dead. Behaviour was already correct, which is why nothing reported it.

      What the upgrade itself then broke was 24 errors in four groups, and three of the four were
      the framework telling the truth about this code. The event map lost its index signature, so
      every event this instance fires has to be declared on `AppEvents`: that is
      `app/domain-events.d.ts`, and writing it caught three payloads whose declared shape was wrong
      (`written` is a per-kind record and not a count, a push's `owner` can be null, and its
      `closedIssues` is the issue numbers rather than how many). `config/errors.ts` had the
      string-length message keyed `min` where the validator calls it `minLength`, and no numeric
      `min` at all. `config/services.ts` still configured an FCM `serverKey`, which Google
      deprecated and the framework has dropped.

      Two things regenerating surfaced that had been latent for longer. `app/Commands/demo-content.ts`
      exported constants from the directory where every file is expected to default-export a command,
      which aborted part of `generate:types`; it is `app/Cli/demo-content.ts` now, beside the other
      command helpers. And `parseRestrictions` was re-exported from both `resources/functions/repo.ts`
      and `resources/functions/review.ts`, which is a duplicate export and therefore a barrel that
      does not compile at all. The 0.70-era barrel never listed either one, so the collision test
      passed by never seeing them. `repo.ts` owns the name now, because branch protection is a
      repository concern, and the one view that read it from `review.ts` reads it from `repo.ts`.

      `ts-images` 0.2.25 also stopped writing `"purpose": "any maskable"` into `site.webmanifest`
      and writes `"any"`. Worth a look rather than a shrug: `maskable` promises Android a safe zone
      this mark does not have, so dropping it is probably the correct claim, but it does change what
      an installed icon looks like.

      Left standing: 13 type errors and 7 lint errors, every one of them upstream and listed below.
      Unit tests are 4,980 passing and 3 failing, and none of the three is this upgrade: two want a
      `repair_settings` table a local database is simply behind on, and the third is the Bun
      backpressure defect [phase 16](./16-hardening-scale.md) pins on purpose.

- [x] **stx** - `0.2.372` could not be installed by anybody: it depended on `@stacksjs/desktop` at
      exactly `0.2.372`, and that package was never published past `0.2.371`, so resolution failed
      outright. Worked around by pinning the whole stx family exactly, since `^0.2.371` floats
      straight back into it. **Resolved upstream**: `desktop` is published through `0.2.378` and the
      family is a caret range again.

- [x] **Not the framework: a stale `env.d.ts`, and eleven variables never declared.** Filed as
      nothing, because reading the contract showed the fault was here. Seven `StacksEnv` type errors
      looked like the generator ignoring `config/env.ts`, and `StacksEnv` really did lose its
      `[key: string]` catch-all. But `storage/framework/types/env.d.ts` is **derived, not
      generated**, as of 0.75: the shipped version is thirteen lines that read the schema,
      `interface StacksEnv extends InferEnv<typeof import('../../../config/env')['default']>`, and
      the `.env`-scraping generator that wrote the old one is the thing the framework moved away
      from. This repository was still holding the scraped 0.70-era file, which is why
      `PAGES_CUSTOM_DOMAINS` typed as `string` where the schema says `schema.boolean()`, and why
      `PAGES_MAX_AGE` was absent while variables that happened to be in the local `.env` were
      present.

      Taking the derived form made the schema's types flow immediately, and turned seven errors into
      a longer and more honest list: eleven variables this instance reads through `env` and never
      declared anywhere. `AUTH_IDLE_TIMEOUT`, `CACHE_DRIVER`, `REDIS_USERNAME`, `REDIS_TLS`,
      `GITHUB_TOKEN`, `PUBLIC_DIFF_ENABLED`, `PUBLIC_DIFF_RATE` and the four `TYPESENSE_*` are in
      `config/env.ts` now with validators and defaults, which is the only thing that types them.
      Three reads changed with them: a variable declared `schema.boolean()` arrives as a boolean, so
      comparing it against `'true'` or `'false'` was the old scraped string type showing through.

      The lesson is the same one the stale declarations taught twice before it. A generated or
      derived file left behind by an upgrade does not report itself; it reports a bug somewhere
      else.

- [x] **Not the framework either: two actions on the wrong side of our own convention.** Four
      errors in `routes/api.ts`, where `'Mcp/McpAction'` and `'Api/GitHubCompatAction'` were not
      assignable to `StacksHandler`, while `tests/e2e/mcp.test.ts` and
      `tests/e2e/github-compat.test.ts` both passed against them. A type describing less than the
      runtime, which looked like a framework gap: `resolveStringHandlerUncached` falls through to
      `appPath(`${modulePath}.ts`)` for any path without `Actions` in it, so `app/Mcp/McpAction.ts`
      resolves, while `ActionPath` is the registry, and the registry is the actions barrel, and the
      barrel scans `app/Actions/**`.

      But the convention this project already follows is the one in
      [AGENTS.md](../../AGENTS.md): an action lives in `app/Actions/<Domain>/`, and `app/<Domain>/`
      holds the support modules around it. `app/Actions/Api/` already had six actions beside the
      eleven support modules in `app/Api/`, and `routes/wellknown.ts` already named its sibling
      `'Actions/Api/JwksAction'`, with the prefix. These two were simply in the wrong directory.
      Moved to `app/Actions/Api/GitHubCompatAction.ts` and `app/Actions/Mcp/McpAction.ts`, named
      with the prefix, and both e2e suites still pass. `docs/api.md` is regenerated, since the
      action name is rendered into it.

- [x] **`storage/framework/defaults` was a badly stale vendored copy, now synced.** Two type errors
      and three lint errors came from it while the published package had none of them, so it was
      never an upstream defect. It was not a two-file fix either: `app/` alone differed in 858 files
      against `@stacksjs/defaults@0.75.81`.

      Synced with the framework's own `syncPackageProjectFiles` rather than by hand, so the
      source-to-target mapping is the one `buddy upgrade` uses: `+497 ~1113 -116` across 1,726
      paths. `buddy upgrade` itself is still not what ran, because it also rewrites `workspace:*` to
      a pinned range. Five paths it wanted outside the defaults tree were reverted to HEAD and
      verified byte-identical afterwards: `buddy`, `bootstrap`, `storage/framework/tsconfig.app.json`,
      `storage/framework/server/tsconfig.docker.json`, and `pantry.lock`, **which the sync wanted to
      delete**.

      Typecheck is 0 for the first time, from 2. Lint is 4, from 7, and all four are now in
      generated or framework-owned files rather than anything this repository writes.

      **What the sync changed about behaviour, which is the part worth reading.** The framework grew
      about thirty-seven default models and three default route files between 0.70 and 0.75, and
      `route.importRoutes()` mounts the default route files alongside this application's own. So
      **269 routes are newly registered**, and the generated document goes from 783 paths to 944.
      Among them: `/api/pledges`, `/api/auctions`, `/api/auction-items`, `/api/couriers`,
      `/api/delivery-stops`, `/api/menus`, `/api/forms`, `/api/sites`, `/api/redirects`, 103 more
      under `/api/dashboard`, plus `/oauth/authorize`, `/auth/magic-link` and `/webhooks/email/*`.

      This is a widening of an arrangement the application already had rather than a new one: the
      committed document already carried 783 paths and 358 mentions of `/api/dashboard` before any
      of this. Worth deciding about deliberately all the same, because a forge serving
      `/api/auctions` is surface nobody asked for.

      **And none of those tables exist.** 209 models are typed in `database/types.d.ts` against 134
      tables in the database: `pledges`, `auctions`, `couriers`, `delivery_stops`, `menus`, `forms`,
      `sites` and `redirects` are all absent, so those endpoints cannot answer. That predates the
      sync too, which only made more of it, and `buddy migrate --diff` is right to report no pending
      changes, because the default models are typed without being migrated. It is still an API
      surface that is mounted and cannot work, and it wants its own decision: either the default
      route files and model APIs should be opt-in for an application that wants none of them, or the
      tables behind them belong in the corpus.

- [x] Two consequences of the sync, fixed with it. `routes/buddy.ts` routed `/commands` at
      `Actions/Buddy/CommandsAction`, which upstream deleted; nothing on this instance called it and
      there is no override, so the route is gone. And `openapi-coverage.test.ts` now excludes
      `/install` and `/test-error`, which the framework's `routes/dashboard.ts` registers inside
      `if (IS_LOCAL_ENV)`: they do not exist on a deployed instance, so documenting them would
      describe a surface nobody can call.


- [ ] **stacks** - `buddy upgrade` rewrites `workspace:*` to a pinned range in the workspace
      packages under `storage/framework`. Those are workspace members, and a version range stops
      them resolving locally, so the one command that delivers the scaffolded declarations also
      does that. The declarations this app was missing (`model-events`, `registries`, `gates`,
      `models`, `request-context`, `authenticated-user`) were copied from
      `@stacksjs/defaults/project/storage/framework/types` instead, which is the same source the
      upgrade's own types step uses.

- [x] **stacks** - **`buddy migrate --diff` says the models match a database that `buddy migrate`
      says is missing tables.** Filed as stacksjs/stacks#2860. Found on this machine, where the
      ledger had fallen behind after the corpus was rebuilt upstream: 82 rows against 304 migration
      files, 82 tables, and **49 of this application's 111 models had no table at all**, every one
      of them with a `create-<table>-table` migration sitting on disk. `--diff` answered "No pending
      schema changes - your models match the database."

      The one-step reproduction is smaller than that. Drop `repair_settings`, which
      `app/Models/RepairSetting.ts` declares, and `--diff` still reports a match, while plain
      `buddy migrate` prints "The live schema does not match the models. Missing tables:
      repair_settings" and then exits `SUCCESS` with "already up to date" without creating it. So the
      dry run contradicts the real run, the real run names the drift and does not repair it, and both
      exit zero. An operator who reads the last line is told the database is fine, and CI only reads
      the exit code.

      **Fixed upstream the same day and verified here on 0.75.81.** `buddy migrate:status` is new
      and names the condition exactly: it reports `0000000297-create-repair_settings-table.sql` as
      REVERTED, "recorded as applied, but the effects are gone from the schema", and exits with
      "Drift detected." `--diff` now reports the missing table and says plainly that migrations will
      not fix it on their own, rather than claiming a match. `--strict` is there for CI. And there is
      a repair short of dropping the database, which was the other half of the ask:
      `migrate:status --reconcile --requeue-reverted` un-records only the migrations whose tables are
      actually gone, and the next `buddy migrate` rebuilds them. Verified end to end here: ledger 304
      to 303 to 304, table back, nothing else touched.

      `migrate:fresh` was the only repair before that, and it worked: 304 ledger rows, 134 tables, no
      model without a table. The 49 were not peripheral, they were `deployments`, `environments`,
      `merge_queue_entries`, `runner_pools`, `git_refs`, `git_wal_entries`, `pages_sites`,
      `atproto_identities`, `managed_tests`, `check_annotations` and `commit_statuses` among others,
      which is phases 9, 10, 13, 15, 16 and 18. None of those features can ever have run here.

- [x] **stacks** - **the seeder never resolves a `belongsTo` to `User`, `Team` or `Customer`, and
      writes `null` instead.** Filed as stacksjs/stacks#2861. The contrast inside a single row is the
      whole bug: `INSERT INTO "stars"("repository_id","user_id")` fails with `null value in column
      "user_id"`, having resolved `repository_id` in the same statement.

      Where the user key is `NOT NULL` the insert fails and the table stays empty. Fourteen of them
      do: `stars`, `watches`, `repo_collaborators`, `org_members`, `team_members`,
      `issue_assignees`, `reactions`, `ssh_keys`, `gpg_keys`, `access_tokens`,
      `notification_subscriptions`, `notification_mutes`, `notification_schedules` and
      `review_checkpoints`, plus `access_token_repositories` and `release_assets` downstream of
      those.

      **Where it is nullable the insert succeeds, which is the half that does real damage.** The
      seeded corpus has 30 issues, 20 pull requests, 60 issue comments, 50 review comments and 25
      reviews, and `author_id` or `reviewer_id` is null on every single one of them, against zero
      nulls in `repository_id` or `commentable_id` on the same rows. So a demo database for a
      product whose entire thesis is the review contains no review with a reviewer and no comment
      with an author, and nothing reports it.

      **It is a hardcoded name list, not a trait.** `relationColumns` in `@stacksjs/database`
      skips any parent for which `isAccountModel(parent)` holds unless `options.allowProtected` is
      set, and `ACCOUNT_MODELS` is `['User', 'Team', 'Customer']`. Nothing to do with `useAuth`,
      which was the first guess here and was wrong: `team_members` populates under the flag too, and
      `Team` carries no auth trait at all. The function only ever *reads* `existingRows`, so the
      list is not protecting `users` from being written to.

      The flag is the other half of the problem. `--allow-protected` is documented as "Seed
      auth/oauth models even on a non-fresh DB (will invalidate live tokens)", and skipping the
      *seeding of* those models is worth keeping. Resolving a foreign key against existing rows
      writes nothing and invalidates nothing, so one flag gates two unrelated things and the
      harmless half is only reachable by opting into the harmful one.

      **Fixed upstream the same day and verified here on 0.75.81, and the flag is no longer
      needed.** Plain `buddy seed --fresh` now reaches 97 of 99 models, where the
      `--allow-protected` workaround only reached 90 of 98: account relations attach to the rows the
      same run seeded, and composite unique indexes are honoured, so `watches`,
      `repo_collaborators`, `repo_topics`, `review_drafts` and `stars` all seed instead of dying on
      their own declared index. Authorship is populated everywhere it was null, with no flag.

      The composite-index half of #2861 is fixed with it. What remains is the polymorphic half: a
      `subject_type` plus `subject_id` pair has no `belongsTo` to resolve from, and a factory is
      handed `faker` rather than a database, so `reactions` and `timeline_entries` are the 2 of 99
      still failing on a null `subject_id`. Left alone rather than papered over by setting their
      seeder counts to zero, which would trade a loud failure for a quiet absence.

- [x] **Two seeder bugs of our own, which only the upstream fix could expose.** Both were hidden
      behind the account-relation defect: nothing downstream of a user could seed, so nothing
      downstream of these could fail either.

      `ReleaseAsset` asks for fifteen rows and `belongsTo: ['Release']`, and `Release` had no
      `useSeeder` at all, so its seeder could never succeed and the releases screen had nothing to
      render. `Release` is seeded now, twelve of them, and the assets attach.

      `RepositoryMirror.repository_id` carried `factory: faker => faker.number.int({ min: 1, max: 8 })`,
      inventing a repository id rather than letting the seeder resolve one. That held only while a
      fresh database happened to number repositories 1 to 8; they are 39 to 46 here after a few
      re-seeds, so every mirror row failed its foreign key. It is `factory: () => null` now, like
      every other relation column in this codebase.

- [x] **A warning about the `overrides` block, which cost an hour here.** Raising stacks to 0.75.81
      broke `buddy migrate --diff` with `export 'parseBearerToken' not found in
      '@stacksjs/bun-router'`, and it was not an upstream bug. `@stacksjs/router@0.75.81` requires
      `bun-router ^0.1.24`; the override in `package.json` forced `^0.1.22`, which does not export
      it. `@stacksjs/ts-cloud` was behind the same way, `^0.16.35` against a required `^0.16.40`.

      This is the same trap the `buddy-bot/update-stacks` branch sets, from the other direction: an
      override that pins a transitive dependency below what stacks asks for fails at *runtime*, with
      a missing export, and installs without complaint. **Audit every entry in `overrides` against
      what the new stacks requires whenever the framework moves**, and consider whether an override
      that merely restates the required range needs to exist at all.

- [x] **The three dependency bumps that outlived their branches.** buddy-bot had proposed each one
      and all six of its branches were deleted upstream before any of them landed, so these were
      taken directly: `@anthropic-ai/sdk` `^0.120.0` to `^0.131.0`, `mermaid` `^11.16.1` to
      `^12.1.0`, and the Dockerfile's base image.

      `mermaid` is the only one with teeth. It is a major, and the package range is not what the
      browser loads: `public/js/mermaid.js` is a committed 3.5MB bundle, built by
      `scripts/vendor-mermaid.ts` and vendored rather than taken from a CDN so that a forge on a
      closed network still draws diagrams and a reader of an issue is not announced to a third
      party. Bumping the range alone would have changed nothing a reader sees, which is the stale
      artifact pattern this phase has now hit four times. Re-bundled, and the asset goes from
      **3.49MB to 5.05MB** - paid only by pages that contain a diagram, since the loader in
      `resources/views/layouts/app.stx` imports it on demand, but worth knowing. Verified by
      importing the built bundle and checking the two functions that loader calls,
      `initialize` and `run`, plus the six markdown e2e tests.

      The base image went to `oven/bun:1.4` rather than the `1.4.2` the bot proposed, because the
      Dockerfile pins a floating minor and always has. Taking a patch pin would have been a second
      decision smuggled in beside a version bump. Worth noting the image was two minors behind what
      this machine runs, which is Bun 1.4.3.

      Left alone: `config/services.ts` still defaults `anthropic.model` to the pinned
      `claude-sonnet-4-20250514`. Nothing reads it - it is framework scaffold, and the live AI path
      is `config/ci-repair.ts`, already on a bare `claude-opus-5` for the reason that file explains.
      Changing an unconsumed default would be churn in a config this project does not own.

- [x] **The framework's default route bundles are opt-in now, and this instance takes none of them.**
      `STACKS_DEFAULT_ROUTES=none` in `.env.example`, which the configuration docs pick up
      automatically from the comment above it. **1,408 registered routes to 714**, and the generated
      document from 944 paths to 447.

      The lever already existed, which is the lesson rather than the change. `route-loader` has
      carried `STACKS_DEFAULT_ROUTES` since stacksjs/stacks#2229, with a long note on why bundles
      are named explicitly instead of gated on `feature()`: `config/auth.ts` ships enabled in every
      scaffolded app, so gating on it would silently widen the public surface of every app on
      upgrade, and "an opt-in that is on by default is not an opt-in". The six bundles are `auth`,
      `dashboard`, `delivery`, `email`, `forms` and `payments`; `social` was already opt-in.

      **The reason this is not tidiness: the `auth` bundle was a second, complete, unused
      authentication surface.** It mounts `/login`, `/register`, `/logout`, `/logout-all`, `/me`,
      `/me/data-export`, `/tokens`, `/refresh`, `/enable-two-factor`, `/oauth/clients`,
      `/referrals` and twenty-eight more at bare paths. This forge has its own under `/api/auth/*`
      and `/api/user/*`, which is what `login.stx`, `register.stx` and `forgot-password.stx` post
      to, and its own passkeys, sessions, two-factor and token management beside them. The default
      set was reachable, parallel, and maintained by nobody here.

      Verified rather than assumed, because turning off auth routes is the kind of change that is
      discovered in production. Every auth, passkey, session and token e2e suite passes: 97 tests
      across seven files. Nothing in `resources/`, `app/` or `tests/` references
      `/webhooks/email`, `/api/forms`, `/webhooks/payments`, `/delivery/`, `/api/contact`,
      `/auth/magic-link`, `/referrals` or `/oauth/clients`, and the only `/api/dashboard` mentions
      are two vocabulary tests that exclude it and one that mocks `fetch`. Turning a bundle off
      stops its routes registering and not its actions resolving, so anything here can still point
      a route at a framework action it never copied.

- [ ] **Model APIs cannot be made opt-in from this repository.** The other half of the question, and
      it needs the framework. `@stacksjs/orm/routes` iterates every model in the auto-imports
      barrel and registers REST routes for any with a `useApi` trait, and the only things it reads
      are `config/qb.ts`, `config/security.ts` for `api.rowScoping`, and
      `STACKS_API_ROW_SCOPING`. There is no allowlist and no per-model gate. `rowScoping` is
      already `deny` here, which only withholds `store`/`update`/`destroy` from models with no
      row-level scoping, and the commerce defaults have `ownership` config so their writes register
      anyway.

      **72 default models carry `useApi`, accounting for 178 of the 714 routes that remain**:
      `auctions`, `bids`, `boards`, `campaigns`, `carts`, `coupons`, `couriers`, `customers`,
      `menus`, `orders`, `payments`, `pledges`, `products`, `redirects`, `sites`, `subscribers`,
      `transactions` and more. The barrel is not configurable either: `defaults/app/Models` is
      hardcoded in five framework packages.

      Four of them are worse than noise because they collide with this product's own vocabulary.
      `/api/reviews` is the framework's *product review* model on a forge built around code review,
      and `/api/comments`, `/api/labels` and `/api/tags` read as this instance's own while being
      something else entirely. See the domain-vocabulary table in [AGENTS.md](../../AGENTS.md) for
      why that matters here more than it would elsewhere.

      Filed as stacksjs/stacks#2866. The shape asked for is the one `STACKS_DEFAULT_ROUTES` already
      proves works: let an application say which models publish an API, with the default being what
      apps get today so nothing changes on upgrade. A `own` selection, meaning only the models in
      `app/Models`, has a precedent worth pointing at - the seeder already behaves that way, since
      `loadAllModels` returns user models alone when the application has any and reaches for the
      defaults only when it has none. The model-API surface having the opposite default is the
      inconsistency.

- [x] **The end-to-end suite is green: 1,584 tests, 0 failures.** It had 21, which had been there
      since August and were found only because this was the first time the whole suite was run
      rather than `tests/unit`.

      **The first version of this entry said CI does not run `tests/e2e`. That was wrong**, and the
      truth is worse. `buddy test` calls `runTestSuites([''])`, which globs `tests/` recursively, so
      CI runs 6,569 tests across 494 files and always has. It had simply been **red on every run
      since 2026-08-22**, including Chris's own last commits, so a red CI was the normal state and
      carried no signal at all. That is the finding behind the other four, and it is fixed in the
      entry below.

      **Thirteen were a stale search index, not code.** Every query answered 503, from
      `Could not find a field named 'pushed_at' in the schema for sorting`: the Typesense
      collections predated that field, and `repositories` held 897 documents against the 8 the
      database has. `./buddy search:reindex <Model>` for each searchable model rebuilt the schemas.
      Worth knowing as an operational step rather than a fix - a reseed does not rebuild the index,
      and the symptom is a search page that answers nothing.

      **Three were a real product bug, and the worst thing found this week.** Branch protection and
      the merge-strategy settings could not be saved from the interface at all. The markup pairs a
      checkbox with a hidden field, which is the only way HTML can send a false, so a ticked box
      arrives as `x=false&x=true` and the router correctly surfaces `['false', 'true']`. Six copies
      of `readFlag` across six actions did `String(value)` on that, got `'false,true'`, matched
      none of their spellings, and returned undefined - which the handlers read as "not sent" and
      answered `422 Nothing to change` to somebody who had just ticked a box. One copy now, in
      `app/Actions/inputs.ts`, taking the last value. The fix had to be made in six places to be
      made at all, which is the argument for it living in one.

      **Three were a test that stopped being true.** `auto-merge` posts JSON with `number: '2'`, a
      string, to an action that declares `schema.number()`. The framework coerces a query or form
      value, because those are always text, and takes a JSON value as sent, because it has a type of
      its own - so the browser form works and the JSON string does not. The test was written on
      2026-08-07 against an action with no `validations` block at all; `e3374927` added one the next
      day. Two sibling tests went on passing because they expect 422 anyway, for the wrong reason.

      **One was eight repositories owned by nobody.** `Repository.owner_id` had
      `factory: faker.number.int({ min: 1, max: 4 })`, the same invented-id bug as
      `RepositoryMirror`, and organizations are numbered 21 to 24 here. The owner is polymorphic, so
      a `belongsTo` is not the fix: it would generate a foreign key on a column that also names
      organizations. `database/seeders/RepositoryOwners.ts` repairs orphans after the model pass
      instead, which is the one place that can see both tables. `app/Ops/admin.ts` falls back to the
      raw id when a handle is missing, deliberately, so the only visible symptom was `4` where every
      other row showed a handle.

      **One was an assertion that predated syntax highlighting.** `browse-tree` looked for
      `export const deeper` in the HTML of a highlighted blob, where it arrives as
      `<span class="t-keyword">export</span>...` and never appears contiguously. The view was right
      the whole time. It asserts the text now, with the tags stripped, which is what the test was
      about.

      One thing checked and found **not** to be a bug, recorded because the first read said
      otherwise: 123 fields across the actions declare `schema.number()` or `schema.boolean()` for a
      value their handler coerces, which looks like the mirror image of the 40 fields
      `app/Actions/inputs.ts` was written for. It is not. Those arrive from a query string or a
      form, both of which the framework coerces to the declared type, and
      `tests/e2e/fine-grained-token-api.test.ts` proves it by passing `number=1` as text to an
      action declaring `schema.number()` and asserting 200. The `coerced` rule is still the more
      honest declaration for a field a handler coerces, but nothing is broken and a 123-field sweep
      would be churn.

- [x] **CI can go green again, which is the only thing that makes it mean anything.** It had been
      red on every run since 2026-08-22. Three causes, and none of them was a missing test run.

      **The lint job failed on four unused imports**, three of them in
      `storage/framework/types/auto-imports.d.ts`, which `buddy generate` writes. `config/code-style.ts`
      already ignored `storage/framework/auto-imports/**` as "never user-editable source"; the
      generated *declarations* were the same category in a different path and were simply not
      matched. They are now. The fourth was a genuinely unused `fs` in
      `storage/framework/server/build.ts` and is gone. Worth noting these had been reported here all
      week as "4 errors, all framework-owned, unchanged" without anybody checking whether they
      gated anything. They gated the whole job.

      **The test job failed on `openapi-coverage`, and that one was ours from yesterday.** CI has no
      `.env`, so `STACKS_DEFAULT_ROUTES` was unset and defaulted to `all`, mounting the 269 default
      routes this instance deliberately does not take, while the committed document describes the
      surface without them. `STACKS_DEFAULT_ROUTES: none` is in the job's env block now, beside the
      other values that are there "because CI has no `.env` at all". Regenerating the document
      instead would have been the wrong fix: a document describing routes this instance does not
      serve is worse than a failing test.

      **And the third failure was the backpressure canary, which nobody read.** See
      [phase 16](./16-hardening-scale.md): it asserts the defect rather than the fix, so it fails
      when Bun repairs it, which Bun did in 1.4.3. It was reported as "the deliberate Bun canary,
      expected" for an entire session. A test expected to fail is indistinguishable from a test that
      is failing, which is precisely how a red CI stops being information.

- [x] **Twenty-three search tests were not skipping in CI, they were passing.** The entry here said
      thirteen tests skipped. Both numbers were wrong and the verb was the important one. Each test
      in `search-page`, `search-action` and `search-push-reindex` opens with `if (!available)
      return`, and a body that returns immediately is a **pass** - so with no node to talk to, all
      twenty-three reported green having asserted nothing, three of them being the check on whether
      a private repository leaks into a stranger's search results. "Skipped" at least sounds like
      absent coverage. This looked like coverage.

      `search` is a service in the `test` job now, `typesense/typesense:30.2`, pinned to the version
      `deps.yaml` installs. Two things were checked rather than assumed, against the pantry build of
      the same version:

      - **It takes all its configuration from the environment.** A service container cannot override
        an image's command the way `compose.yaml` does, so the `--data-dir` and `--api-key` it
        passes are unavailable. `typesense-server` with no arguments reads `TYPESENSE_DATA_DIR` and
        `TYPESENSE_API_KEY` and serves `/health`.
      - **It refuses to start when its data directory does not exist.** "Data directory ... does not
        exist", and it exits before listening. Nothing creates one inside a service container, so
        the obvious `TYPESENSE_DATA_DIR: /tmp/typesense` would have failed the job before the first
        step. It is `/tmp`, which is always there.

      Readiness is a step on the runner rather than a `--health-cmd` on the service, because a
      health check runs inside the service image and what that image ships is not checkable from
      here - while curl on `ubuntu-latest` is a given. It dumps the container's log before failing.

      And the skip is loud now: when the search node is the thing missing and `CI` is set, the
      three suites rethrow instead of warning. Verified in all three directions - no node and `CI`
      set fails the file, no node without `CI` still stands down with a warning, a node present
      passes 23. The previous note called a health check unguessable "with no Docker to try it
      against"; there were four working service containers in the same file and the thing that
      actually needed trying was the server's own behaviour, which pantry had installed all along.

- [x] **Two MySQL failures and two suites that stood down, all three from a timestamp.** The run on
      `025514cf` was green on lint, typecheck and the Postgres leg, and failed on MySQL with
      `p95_ms` reading 600001 against an expected 600000.

      Not a dialect difference. `tests/e2e/insight.test.ts` called its `ago()` helper - which is
      `Date.now()` minus an offset - three separate times for what the fixture means as one instant,
      so whenever the clock ticked between two of them the measured wait was off by exactly the
      tick. Postgres had been winning that race, not avoiding it. The instant is read once now and
      the other two values derived from it.

      The same run also lost `tests/e2e/reviewer-load.test.ts` and `pull-list-and-stack.test.ts`
      entirely, each to one warning in the log: both wrote `created_at` as an ISO-8601 string, MySQL
      refuses that for a `datetime` column, and the throw landed in the `beforeAll` catch that
      exists to stand down when there is no database. `dbTimestamp` has existed for this since
      August and says so in its own doc comment; these two predate it. Note that
      `pull_request_reviewers.responded_at` next to one of them is a `varchar(255)` holding an ISO
      string and is correct as it is: the schema decides which is which, not the column name.

## Known gaps, deferred deliberately

- [x] **Stacks** - `notifications.user_id` and `notification_deliveries.user_id` foreign keys were
      missing from the live schema on every installation, not just this one.

  The last note here had the reproduction right and the mechanism half right, and guessed at the
  ordering. It is not a guarantee running during boot: `runDatabaseMigration` calls
  `migrateNotificationTables()` **before** the model batch, deliberately and with a comment saying
  why - a generated model migration may normalize or rebuild these tables and needs them to exist
  first. That is also exactly why the keys never landed. The guarantee creates the table without
  them, and the model's own `CREATE TABLE IF NOT EXISTS … REFERENCES "users"("id") ON DELETE
  CASCADE` is then a no-op against a table that already exists. The migration runs, the corpus
  declares the key, and the key is not there.

  Putting `REFERENCES` inline in the guarantee does not work either: on a brand-new database nothing
  has created `users` yet, so the CREATE would fail and take the boot with it.

  Fixed in Stacks 0.70.318 by adding the keys **after** the batch, when `users` is certain to exist
  - the same defensive-ALTER-and-swallow pattern `ensureUsersAuthColumns` already uses in
  `auth-tables.ts`, and for the same reason: an installation that has deliberately dropped the
  relation must not fail its migration over a constraint it does not want. Verified against this
  database, which now carries both with the cascade.
- [x] The `jobs` table was dropped by `migrate:fresh` and not recreated by the corpus, so seeding
      skipped it.

  Resolved by the thing that fixed the queue itself: `app/Models/Job.ts` overrides the framework
  default, because two of its columns describe something other than what `@stacksjs/queue` stores.
  A model in the corpus means a generated migration in the corpus, so
  `0000000012-create-jobs-table.sql` is replayed by `migrate:fresh` like anything else - the table
  had been missing precisely because nothing described it here.
- [x] Pantry could not auto-activate environments under the `den` shell: it recognized zsh, bash,
      fish and nushell, and den has no `chpwd` or pre-prompt hook to attach to.

  Fixed upstream and verified against the installed binary - `PANTRY_SHELL=den pantry dev:shellcode`
  emits it. The hook is written out and sourced rather than eval'd, because den's `eval` parses its
  argument as a command chain and a chain cannot carry a function definition, so an eval'd hook
  defines nothing. It also looks nothing like the bash template on purpose: in den a `[` test costs
  around 5ms where bash measures it in microseconds, so the shell-side parent walk that other shells
  use would spend most of a second per `cd` deciding a directory is not a project. It forks
  `pantry shell:lookup` once instead and lets native code walk.
