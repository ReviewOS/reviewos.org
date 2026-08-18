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

- [ ] Dialect audit of the query layer: several hundred `selectFrom` sites in `app/Actions/` and
      the views. bun-query-builder abstracts the dialect, so the audit hunts raw SQL fragments and
      Postgres-isms: `ILIKE`, `RETURNING`, `ON CONFLICT`, JSON operators, enum types. Findings
      that are the tool's gap get fixed in bun-query-builder upstream, per the standing rule - and
      per the five silent query-builder failures in the [index](./index.md), every fix arrives
      with the SQL checked, not the shape of the call.
- [ ] Regenerate the migration corpus against the mysql dialect with
      `./buddy generate:migrations`. The 198 migrations are model-generated, so this is
      regeneration and review rather than hand-porting; the review checks charset and collation
      (`utf8mb4`), enum handling (MySQL native enums versus the Postgres `CREATE TYPE` dance the
      generator already fought once), and index length limits - `ReviewThread.path` at 1024
      characters needs a prefix index on MySQL.
- [ ] The two idempotency properties from the migration workflow hold on MySQL: generating twice
      writes once, migrating twice applies once.
- [ ] Engine migration tooling for existing installs: a `buddy db:migrate-engine` command that
      dumps through the query builder, replays into MySQL, and verifies row counts and checksums,
      with a documented downtime procedure. Postgres remains a supported connection through one
      release cycle, then deprecated.
- [ ] CI runs the full suite against MySQL; the test database utilities gain the dialect matrix.
- [ ] Pantry: declare `mysql.com` in `config/deps.ts` (it is in pantry's package set), with the
      same service provisioning Postgres gets today - `buddy setup` creates the database and role
      from `.env`.
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
