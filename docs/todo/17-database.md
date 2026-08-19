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
- [ ] Engine migration tooling for existing installs: a `buddy db:migrate-engine` command that
      dumps through the query builder, replays into MySQL, and verifies row counts and checksums,
      with a documented downtime procedure. Postgres remains a supported connection through one
      release cycle, then deprecated.
- [ ] CI runs the full suite against MySQL; the test database utilities gain the dialect matrix.
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
- [ ] `docs/self-hosting.md` and `.env.example` updated; fresh installs default to MySQL.

## Vitess mode

Starts only after single-node MySQL is the default and stable.

- [ ] Extend pantry upstream with a Vitess package. Pantry has `mysql.com` and `planetscale.com`
      today but no `vitess.io`, and a Vitess-mode instance should still be pantry-provisioned -
      service definitions for vtgate, vttablet, and the topology server are part of that work.
- [ ] Keyspace and vindex definition on `repository_id`; tables without a repository owner (users,
      organizations, sessions, tokens) live in an unsharded keyspace.
- [ ] Verify the hot transaction shapes are single-shard: ref ledger CAS plus WAL insert (phase
      18c), review submit, check reporting, merge queue claim.
- [ ] Sequence strategy for auto-increment ids under Vitess (sequence tables), or finish moving
      the remaining tables to the uuid trait and sidestep it.
- [ ] vtgate connection config in `config/database.ts`, env-switched like every other driver
      choice.
- [ ] A load test proving the claim: a repo-sharded keyspace under a clone-storm write load, with
      cross-shard queries measured and named rather than discovered in production.
