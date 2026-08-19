# 17 - Database scale-out (MySQL and Vitess)

The metadata database moves from Postgres to MySQL, and Vitess becomes the horizontal scale-out
topology for instances that outgrow one database server. The decision is recorded here with its
costs, because a database migration proposed without its costs gets re-litigated every quarter.

What this buys: a proven sharding story (Vitess runs YouTube-scale MySQL, and PlanetScale sells it
as a product), and a metadata tier that scales horizontally the same way phase 18 makes the git
tier scale. What it costs: a dialect migration across a large query surface, a data migration for
every existing install, and a second database engine to support during the transition.

Two commitments hold regardless:

**Self-hosters never run Vitess.** Plain single-node MySQL is the supported mode for one box,
installed by pantry like every other system dependency, swapped in by `DB_CONNECTION` exactly as
Postgres is today. Vitess - vtgate, vttablet, a topology server - is opt-in for large and hosted
instances only. The zero-extra-dependency principle from phase 11 is not negotiable.

**The sharding key is `repository_id`, decided now.** Nearly every hot table (pull requests,
reviews, threads, comments, checks, runs, the phase 18 ref ledger and push WAL) is owned by a
repository, so a repo-sharded keyspace keeps a ref transaction, a review submit, and a push WAL
insert each on a single shard - single-shard transactions are the thing Vitess does at full speed
and full consistency. Cross-repository reads (global search, dashboards, notification fan-out)
already go through Typesense, denormalized counters, and id-paged jobs rather than joins, which is
why the raw `selectFrom` access pattern here survives sharding better than an eager-loading ORM
would have. Phase 18's linearizer is designed against this decision: per-repo `GET_LOCK` on
single-node MySQL, single-shard compare-and-swap transactions under Vitess, and no dependency on
Postgres advisory locks.

## Sequencing

Phase 16 does not depend on this. Phase 18a and 18b (blob store, push WAL) are database-agnostic
and can proceed in parallel. Phase 18c (the ref ledger) waits for single-node MySQL to land here,
so the linearizer is built once, on the engine it will live on.

## Single-node MySQL

- [x] Dialect audit of the query layer: several hundred `selectFrom` sites in `app/Actions/` and
      the views. bun-query-builder abstracts the dialect, so the audit hunts raw SQL fragments and
      Postgres-isms: `ILIKE`, `RETURNING`, `ON CONFLICT`, JSON operators, enum types. Findings
      that are the tool's gap get fixed in bun-query-builder upstream, per the standing rule - and
      per the five silent query-builder failures in the [index](./index.md), every fix arrives
      with the SQL checked, not the shape of the call.

      The prediction held: the builder covers the surface, and the whole of the Postgres in this
      codebase was **eight hand-written statements and two clock reads**. No `ILIKE`, no JSON
      operators, no array functions, no advisory locks anywhere.

      What was found, and what happened to it:

      - **Three `INSERT ... ON CONFLICT ... DO UPDATE`** - the viewed-files tick, the review draft,
        the last-look checkpoint - now go through the builder's own `upsert`, which spells
        `ON DUPLICATE KEY UPDATE` on MySQL. That was the tool's gap and the tool already had the
        answer; the statements were written by hand because an older builder emitted SQL Postgres
        refused, and the comment saying so outlived the defect.
      - **One `SELECT DISTINCT ON`** in the review queue, which MySQL has no equivalent for at all.
        Rewritten as `MIN(created_at)` with a `GROUP BY`: the same rows, standard SQL, and the
        plainer statement - what the query asks for is "how long has this been waiting", which is a
        minimum.
      - **Two readings of the database's clock**, `CURRENT_TIMESTAMP::timestamp` in the health check
        and `LOCALTIMESTAMP` in the audit's offset probe. One spelling now, `LOCALTIMESTAMP`, which
        both engines have and which is what a naive column stores - and one constant, because two
        spellings of one measurement is how they end up measuring two different things.
      - **Every remaining raw statement** goes through `portable()`, which moves `$1` to `?` and
        `"ident"` to backticks when the connection speaks MySQL. Both are silent failures rather
        than loud ones: MySQL reads `"state"` as a string literal, so `WHERE "state" = 'open'`
        becomes a comparison of two constants that returns nothing and raises nothing.

      **The audit is a test, not a memory.** `tests/unit/sql-portability.test.ts` scans `app/`,
      `routes/` and `resources/` for constructs MySQL does not have and for raw statements that
      reach the driver unspelled, with the remedy on each rule. It is matched case-sensitively,
      because the builder's own `.returning()` and `.distinctOn()` are the portable path - a
      case-insensitive first draft flagged sixty call sites that were already right, which is how a
      guard test teaches people to disable it.
- [x] Regenerate the migration corpus against the mysql dialect with
      `./buddy generate:migrations`. The 198 migrations are model-generated, so this is
      regeneration and review rather than hand-porting; the review checks charset and collation
      (`utf8mb4`), enum handling (MySQL native enums versus the Postgres `CREATE TYPE` dance the
      generator already fought once), and index length limits - `ReviewThread.path` at 1024
      characters needs a prefix index on MySQL.

      `database/migrations/mysql/` holds 99 files, one `CREATE TABLE` per model table, generated
      from the same models as the Postgres corpus. `resolveMigrationDirectory` picks the
      per-dialect directory on its own once a second snapshot exists, so the two corpora never
      mix. Applying it produces 119 tables (the 99 plus the framework's auth, notification, RBAC
      and trait tables), 124 foreign keys, every table utf8mb4.

      **Regeneration is one command; the review was five defects, four of them silent.** Every fix
      is upstream, because every one of them would have hit any other project moving to MySQL:

      - **Foreign keys were all discarded.** The generator wrote them as column-level
        `REFERENCES`, which MySQL parses and throws away - its own manual says so - accepting the
        DDL and creating no constraint. The corpus applied cleanly, reported success, and left a
        database with none of its 123 foreign keys. Now emitted as named table-level constraints
        (bun-query-builder 0.2.48).
      - **`DEFAULT UTC_TIMESTAMP` is a syntax error on MySQL.** It takes exactly one function
        unparenthesized in a column default, `CURRENT_TIMESTAMP`; anything else needs the
        `DEFAULT (expr)` form from 8.0.13. Every framework table that defaults a timestamp -
        auth, notifications, RBAC, the polymorphic traits - failed to create. This one at least
        failed loudly (Stacks `5e22676842`).
      - **An index on a TEXT column had no key length**, which MySQL refuses outright: a model
        string over 767 characters becomes TEXT, so the review thread's file path was the first of
        several. Long columns now take a 255-character prefix (0.2.48).
      - **A composite key can overrun 3072 bytes with no single column near it**:
        `managed_tests (test_suite_id, scope, name)` is 4008. The whole key is now measured and
        the widest string parts narrowed one at a time, so a UNIQUE index keeps every distinction
        it can (0.2.49).
      - **The character set was whatever the operator's server defaulted to.** MySQL 8 defaults to
        utf8mb4, so this changes nothing on a stock server - which is the point: a server still
        configured for latin1 silently created latin1 tables, and the first four-byte character
        would be rejected years later. `DEFAULT CHARSET=utf8mb4` is now explicit; the collation is
        deliberately still the server's, since naming MySQL 8's would make the DDL unusable on
        MariaDB (0.2.48).

      Two things the review found and did *not* change. **Enums came out right** with no work:
      native `ENUM('public', 'private', 'internal')`, no `CREATE TYPE` dance. And **the drift
      audit called every boolean column a mismatch** - MySQL has no boolean type, `BOOLEAN` is a
      spelling of `TINYINT(1)` - so 51 warnings fired on a schema the same tool had just
      generated. Exempted rather than silenced (0.2.50), because a report that fires on a clean
      database is one people learn to scroll past.

      `tests/unit/mysql-corpus.test.ts` holds the review: it reads the corpus rather than the
      generator, because what matters is what an operator's database ends up with.

      **Two things to know before regenerating either corpus.** The per-dialect directory is
      chosen by `resolveMigrationDirectory`, and it used to hand the *incumbent* dialect a fresh
      empty subdirectory the moment a second snapshot existed - so the first Postgres run after
      this work wrote into `database/migrations/postgres/`, orphaning 206 applied files. Fixed
      upstream (Stacks `127c2bd3c8`): a non-empty flat corpus is now claimed by whoever wrote it,
      read off the identifier quoting. Until that release lands here, pass an **absolute**
      `DB_MIGRATIONS_PATH` to pin a corpus - a relative one equal to the default is ignored, which
      is its own small trap. And the mysql snapshot stays out of git (it is in `.gitignore`
      already, for a different reason), which is what keeps CI generating Postgres into the flat
      directory.

      MySQL runs locally as a pantry service on port 3307 (`pantry start mysql --port 3307`),
      alongside the Postgres this instance still uses. Installing it at all took four pantry
      fixes; see the pantry note under the `config/deps.ts` box below.

      One finding is left open on purpose. `created_at` defaults to `CURRENT_TIMESTAMP` in the
      model-generated corpus on **both** engines - the session's local wall clock, which is the
      exact bug `sqlHelpers.utcNow` exists to prevent and which the framework fixed only for its
      own hand-written tables. It is not a MySQL regression and fixing it rewrites the default on
      every table in every existing install, so it wants its own change with a migration story
      rather than a quiet rider on this one.
- [x] The two idempotency properties from the migration workflow hold on MySQL: generating twice
      writes once, migrating twice applies once.

      Generating twice: 99 files, then 99 files, byte-identical SQL. Migrating twice: 99 rows in
      `migrations`, 119 tables, 124 foreign keys, and the second run says "nothing to migrate".
      Both measured against a MySQL 9.2 server after a drop-and-recreate, not inferred.
- [x] Engine migration tooling for existing installs: a `buddy db:migrate-engine` command that
      dumps through the query builder, replays into MySQL, and verifies row counts and checksums,
      with a documented downtime procedure. Postgres remains a supported connection through one
      release cycle, then deprecated.

      `app/Actions/Database/engineMigration.ts` copies through the drivers rather than through
      `pg_dump`, because the engines disagree about booleans, about identifier quoting, and about
      what a timestamp with no zone means to a client library - and a restore that lands 99% of the
      rows looks exactly like one that lands all of them. Every table is counted on both sides and
      hashed on both sides, over the *values* as the application would read them, so a boolean that
      arrived as the wrong number or a timestamp shifted by the host's offset fails the table.

      Three things it does that a naive copy would not, each of which was a bug first: timestamps
      move as **text**, since a driver handed a naive `2026-08-19 02:15:38` assumes the host's zone
      and a machine seven hours behind UTC lands every one of them seven hours out; it pages by
      **primary key** rather than OFFSET, which is not a stable window over a table being read, and
      seeds the page with a value of the key's own type, since `WHERE "id" > -1` against a varchar
      key is an error on Postgres rather than a no-op; and it **resets the auto-increment** past
      what it wrote, because a copy writes explicit ids and neither engine moves its counter, so
      the first row the application inserted afterwards would collide.

      Run against this instance: **118 tables, 10380 rows, every table matching on both count and
      checksum.** The source is only ever read, so rolling back is putting the old `DB_CONNECTION`
      back. `tests/e2e/engine-migration.test.ts` covers the canonicalizer and the digest without a
      database, and the round trip with both engines present.

      The downtime procedure is in [self-hosting](../self-hosting.md#changing-the-database-engine):
      stop the app and the worker, apply the target corpus, copy, switch `DB_CONNECTION`, start
      again. The copy is not online - a row written while it runs is a row it does not carry - so
      the stop is the part that matters rather than the duration.
- [x] CI runs the full suite against MySQL; the test database utilities gain the dialect matrix.

      `ci.yml`'s `test` job is a matrix over `[postgres, mysql]` with
      `fail-fast: false` - when one engine breaks the useful question is whether the other did too -
      and `tests/helpers/dialect.ts` answers "which engine is this run" and "where is the other one"
      in one place, which is what the engine-migration suite needs to reach both at once.

      **Both engines are green.** MySQL 1324 of 1327 end-to-end tests, Postgres 1322 - and the three
      that fail are the *same* three on both, so there are no MySQL-only failures left. The unit
      suite is 4001 of 4001 on each. It started at 197 MySQL failures against Postgres's 2.

      Getting there was nine defects, and none of them was in the migration corpus. Every one was a
      place where a query, a value, or a comparison assumed Postgres, and every one failed *quietly*:

      | What assumed Postgres | How it failed on MySQL |
      |---|---|
      | `INSERT ... RETURNING` | Syntax error at the end of a valid insert. An insert whose id nothing can read is a row nothing can reference, so this is every create path there is. |
      | `UPDATE`/`DELETE ... RETURNING` | The same. The update emulation reads the rows *before* it writes, because a predicate that tests what the write changes matches nothing afterwards - `spendRecoveryCode` is exactly that shape and reported that no code had been spent. |
      | Unquoted identifiers | `condition`, `uses`, `key` are reserved there. One SELECT failed 167 times in a run, and the message named the *next* token. |
      | `ORDER BY key` | Same reservation, different clause. |
      | `CAST(x AS varchar)` | No such type; and `AS CHAR` means `character(1)` on Postgres, so the obvious translation truncates every value to one letter. The cast also has to name a charset or "Illegal mix of collations" kills the join. |
      | An ISO-8601 date | `2026-08-19T04:37:11.396Z` is not a datetime literal: the `T`, the fraction and the `Z` are all outside one. |
      | `x === true` on a row | MySQL has no boolean type. A workflow that accepts `workflow_dispatch` answered 409, "this workflow does not accept workflow_dispatch", because `on_dispatch !== true` is true of the number 1. |
      | The same in a view | The dispatch control simply was not rendered, and nothing anywhere said why. |
      | A duplicate-key error | Postgres says 23505 and "duplicate key"; MySQL says 23000, errno 1062, "Duplicate entry". A redelivered push - *success* for that path - raised out of the dispatch loop instead of counting itself. |

      Six were the query builder's and are fixed there (bun-query-builder 0.2.54 through 0.2.57);
      three were this application's, and are now `isTrue` / `isNotFalse` / `dbTimestamp` in
      `app/Actions/Support/sql.ts` with `resources/functions/truth.ts` for the views, which resolve
      their imports from `resources/` rather than from the file.

- [x] Pantry: declare `mysql.com` in `config/deps.ts` (it is in pantry's package set), with the
      same service provisioning Postgres gets today - `buddy setup` creates the database and role
      from `.env`.

      It is *not* declared in `config/deps.ts`, and that is the finding: the engine is chosen by
      `DB_CONNECTION` and swapped into the generated `deps.yaml`, so naming one here would install
      a second engine nothing connects to. With `DB_CONNECTION=mysql`, setup writes
      `mysql.com: ^9.2`, drops the unused engine, and keeps `mysql` in `services.autoStart` -
      run and checked, not read off the source. The placeholder's comment in `config/deps.ts` now
      says so, since "sqlite" with no explanation reads like a decision rather than a slot.

      Pinned `^9.2` upstream (Stacks `e89b7427a4`): it was `*`, and MySQL upgrades its data
      directory in place and never downgrades, so an ordinary `buddy setup` could take a live
      cluster to the next major with no way back. Postgres carries `^17.10` for exactly that
      reason, with the comment right above the line that did not.

      Getting MySQL installed at all took four pantry fixes (pantry `b8c3d1b7c`), and one of them
      is worth reading twice: `pantry install bun.com` was serving npm's `bun` package - a
      postinstall shim with no runtime in it - because the binary registry had no artifact under
      that domain and the fallback matched on the short name. `mysql.com` would have become npm's
      `mysql` driver by the same route had the registry not answered first.
- [x] `docs/self-hosting.md` and `.env.example` updated; fresh installs default to MySQL.

      `DB_CONNECTION=mysql` in `.env.example`, `mysql:8.4` in `compose.yaml` as the `database`
      service - named for what it is rather than for one engine, since it is now the thing that
      changes - and self-hosting documents
      [changing the engine](../self-hosting.md#changing-the-database-engine), the downtime
      procedure, the rollback and the deprecation window. The backup and restore recipes are
      MySQL's, with the Postgres spelling kept beside the one it replaced.

      The default flipped only once the MySQL job was green, which is the order the box above
      insisted on: pointing every fresh install at an engine whose suite has not run is how a
      default becomes a support burden.

## Vitess mode

Starts only after single-node MySQL is the default and stable.

- [x] Extend pantry upstream with a Vitess package. Pantry has `mysql.com` and `planetscale.com`
      today but no `vitess.io`, and a Vitess-mode instance should still be pantry-provisioned -
      service definitions for vtgate, vttablet, and the topology server are part of that work.

      The package exists (`vitess.io`, built from source with `CGO_ENABLED=0` so it is static and
      cross-compiles to arm64, which the upstream release tarball does not). What was missing is the
      other half of the box, and is now in pantry: **`vtgate`, `vttablet` and `vttopo`** as service
      definitions, so a cluster is `pantry start` three times rather than three hand-written unit
      files.

      Three details in them are load-bearing rather than decoration. `vttopo` is etcd with
      `--advertise-client-urls` set, because without it etcd advertises a hostname vtgate may not
      resolve and the failure reads as "topology server unavailable" on a store that is running
      perfectly. It gets port 2389 and a data directory of its own, so a Vitess cluster and an
      application's own etcd on one box are not the same store - clearing one would clear the other.
      And vtgate's health check probes its status endpoint rather than the MySQL port, because it
      serves that page before it will accept a query.

      **Not installable on darwin-arm64 yet.** The registry has only the linux-x86-64 artifact; the
      recipe restricts nothing, so this is a build the fleet has not run rather than a limitation.
      It is why the load test below is written and unrun.
- [x] Keyspace and vindex definition on `repository_id`; tables without a repository owner (users,
      organizations, sessions, tokens) live in an unsharded keyspace.

      **Computed from the schema, not written down.** `buddy db:keyspaces` reads the live MySQL
      schema and emits both VSchemas plus the sequence tables into `database/vitess/`; a model added
      next month is classified the first time anybody asks rather than whenever somebody remembers
      to edit a JSON file. Today: **34 tables shard on `repository_id`, 66 have no repository and
      live in `reviewos_global`.**

      Three decisions are in there, and each one was a thing to get wrong:

      - **`repositories` shards on its own `id`.** It has no `repository_id` and does not want one -
        its key *is* the value everything else routes on - so it takes the same vindex over a
        different column. Left in the unsharded keyspace, a push would cross keyspaces on the one
        transaction the sharding key was chosen for.
      - **`xxhash`, not `hash`.** The older vindex is defined only over 64-bit integers, and a
        keyspace is not a thing to re-shard because a column type changed later.
      - **Every sharded table names a sequence** in the unsharded keyspace, because a sharded
        keyspace has no auto-increment: two shards handing out `id = 4` is not a conflict either of
        them can see. `sequences.sql` carries the `COMMENT='vitess_sequence'` vtgate looks for, and
        seeds with `ON DUPLICATE KEY UPDATE next_id = next_id` so re-running it on a live cluster
        cannot hand out ids somebody already has.

      `tests/unit/vitess-keyspaces.test.ts` holds all of it.
- [x] Verify the hot transaction shapes are single-shard: ref ledger CAS plus WAL insert (phase
      18c), review submit, check reporting, merge queue claim.

      **All five, and the check is what says so.** `buddy db:keyspaces --check` reads the live
      schema, computes the keyspaces, and exits non-zero when any named transaction would leave one
      shard. It now exits zero:

      | Transaction | Single-shard |
      |---|---|
      | a push writes the ref ledger and the WAL | yes |
      | a review is submitted | yes |
      | a check is reported | yes |
      | the merge queue claims an entry | yes |
      | a workflow run is dispatched | yes |

      Getting there was the finding of this box: **25 child tables carried no `repository_id`.** A
      row under a pull request or a run is owned by a repository transitively, and Vitess cannot
      infer that - a lookup vindex could, at the cost of a cross-shard read on every write, which is
      the thing being avoided. So each one carries the column now, denormalized from its parent.

      Three layers of it, and the deeper ones only appeared once the layer above was fixed - which
      is the argument for computing the plan rather than writing it down:

      - 18 children of a sharded table (`review_threads`, `workflow_jobs`, `pull_request_reviews`,
        ...);
      - 5 grandchildren whose parent had just gained it (`review_comments`, `workflow_steps`,
        `test_executions`, `workflow_job_logs`, `workflow_version_jobs`);
      - 2 more below those (`workflow_step_attempts`, `workflow_version_steps`).

      The column is written where the row is created, from the parent already in hand - about forty
      insert sites, not one lookup - so no write pays a read for it. Rows that predate the column
      are filled by `buddy db:backfill-shard-key`, which is separate from the migration on purpose:
      adding a nullable column is instant, and reading every workflow log an instance has ever kept
      is not. It batches, it is safe to interrupt, and "still null" is its cursor, so running it
      twice costs nothing. Rows whose parent was deleted stay null and are reported rather than
      guessed at.

      60 tables shard on `repository_id`, 59 have no repository and live in `reviewos_global`, and
      nothing is left owing the column.
- [x] Sequence strategy for auto-increment ids under Vitess (sequence tables), or finish moving
      the remaining tables to the uuid trait and sidestep it.

      **Sequence tables, not uuid.** The uuid route sidesteps the problem and pays for it forever:
      every foreign key becomes 16 bytes instead of 8, every secondary index grows with it, and an
      InnoDB primary key that arrives in random order turns an append into a page split - on the
      tables that grow fastest, which are exactly the sharded ones. The models already carry
      `useUuid` for external identity, and that is the right division: a uuid is what a URL and an
      API show, and an integer is what the storage engine orders by.

      So `db:keyspaces` emits one sequence table per sharded table into the unsharded keyspace, and
      the VSchema points each table's `id` at its sequence. vtgate reserves a block of 1000 per
      gate, so the counter is touched once per block rather than once per insert; the cost is a gap
      in the ids after a restart, and nothing in this schema reads an id as a count.
- [x] vtgate connection config in `config/database.ts`, env-switched like every other driver
      choice.

      `DB_CONNECTION=vitess` selects it, port 15306 by Vitess's own convention. vtgate speaks the
      MySQL wire protocol, so the driver, the SQL and the schema are the ones single-node MySQL
      already uses - which is the whole reason the dialect work above was worth doing on MySQL
      rather than on Vitess.

      Named as its own connection rather than pointed at through `mysql`, because
      `dialectCapabilities` has to tell them apart: a sharded keyspace has no auto-increment and no
      cross-shard foreign keys, and the migration generator needs to know that before it emits
      either. The builder already treats `vitess` as MySQL-wire for everything a query does.
- [x] A load test proving the claim: a repo-sharded keyspace under a clone-storm write load, with
      cross-shard queries measured and named rather than discovered in production.

      **Written, unrun.** `tests/e2e/vitess-load.test.ts` drives the phase-18c write shape - a ref
      ledger row and a WAL entry per push - across 64 repositories, and reads the count of queries
      vtgate routed to more than one shard *from vtgate's own `/debug/vars`* rather than inferring
      it. It reports p50 and p99 and fails when the tail is fifty times the median, because a p99
      many times the p50 is what a cross-shard write looks like from outside.

      It skips when no cluster answers, and says so in the run's output rather than passing quietly:
      a skipped test that reports success is how an unmeasured claim comes to be believed.

      **It has now run against a real cluster.** Vitess v24.0.2 built from source for darwin-arm64,
      a `vtcombo` with two shards (`-80`, `80-`) over the pantry MySQL, the generated vschema and
      sequence tables applied, and the phase-18c write shape driven across 64 repositories:

      | | |
      |---|---|
      | writes | 3200 |
      | p50 | 0.14ms |
      | p99 | 0.47ms |
      | queries vtgate routed to more than one shard | **0** |

      The zero is only worth something if the load actually spread, so that was measured too: the
      64 repositories land 24 on one shard and 40 on the other, and every write still stayed on the
      shard its `repository_id` routes to. A p99 three times the p50 is a distribution with no
      cross-shard write hiding in it.

      What this does not prove is a cluster under failover, a resharding, or a keyspace larger than
      one machine - it proves the schema is shaped so a write keyed by repository touches one shard,
      which is the claim the design rests on and the one that was unmeasured.
