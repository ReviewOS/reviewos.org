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
- [ ] **pickier** - A function whose return type is written as an inline union
      (`): { ok: true, ... } | { ok: false, ... } {`) makes `no-unused-vars` report every parameter
      as unused, because the parser does not find the body. Naming the union and referring to it is
      the workaround, and it is better code anyway, so this is worked around here rather than
      blocking. `transitionDraft` in `app/Actions/Pull/state.ts` is the case that found it.
- [x] **bun-query-builder** - Enum type names are table-qualified, but only newly added columns were
      stamped with the qualified name, so altering an existing enum column referenced a type nothing
      creates. Migrating to Postgres died on the last file with `type "channel_type" does not exist`.

## Known gaps, deferred deliberately

- [ ] `notifications.user_id` and `notification_deliveries.user_id` foreign keys are missing from the
      live schema. Those tables are created by the framework's guarantee path rather than the model
      corpus, so the declared relations are not enforced. Harmless today, worth fixing before the
      notification work in phase 5.
- [ ] The `jobs` table is dropped by `migrate:fresh` and not recreated by the corpus, so seeding
      skips it. Needs resolving before the queue matters in phase 5.
- [ ] Pantry cannot auto-activate environments under the `den` shell: it recognizes zsh, bash, fish,
      and nushell, and den has no `chpwd` or pre-prompt hook to attach to. Tracked in
      [phase 11](./11-self-hosting-deploy.md); `./buddy setup` covers the same ground explicitly in
      the meantime.
