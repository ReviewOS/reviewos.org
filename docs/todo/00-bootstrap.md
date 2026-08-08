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
