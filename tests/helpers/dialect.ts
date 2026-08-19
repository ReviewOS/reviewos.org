/**
 * Which engine the suite is running against, and how to reach the other one.
 *
 * Phase 17 moves the metadata database to MySQL, and the suite runs against
 * both: CI has a job per dialect and a developer switches with `DB_CONNECTION`.
 * Almost nothing in the suite should care - that is the point of the query
 * builder - but three kinds of test do, and they were each answering the
 * question their own way:
 *
 * - one that asserts on generated SQL, which is dialect-specific by nature;
 * - one that needs the *other* engine as well, like the engine migration;
 * - one that has to skip where an engine genuinely lacks the feature.
 *
 * A test that reads `process.env.DB_CONNECTION` inline gets the default wrong
 * (it is `sqlite` in the framework and `postgres` here), so the answer lives
 * once, here.
 */

import process from 'node:process'

export type Dialect = 'postgres' | 'mysql'

/** How to reach a database. Shaped for `Bun.SQL` and for the engine migration. */
export interface DialectConnection {
  adapter: Dialect
  hostname: string
  port: number
  database: string
  username: string
  password: string
}

/**
 * The engine this run is using.
 *
 * `postgres` when nothing says otherwise, because that is what this
 * application's `.env.example` ships and what an unconfigured checkout gets -
 * not the framework's `sqlite` default, which no ReviewOS instance runs.
 */
export function activeDialect(): Dialect {
  return String(process.env.DB_CONNECTION ?? 'postgres').toLowerCase() === 'mysql' ? 'mysql' : 'postgres'
}

/** Whether the connection under test speaks MySQL. */
export function runningOnMysql(): boolean {
  return activeDialect() === 'mysql'
}

/**
 * Where an engine is, from the environment.
 *
 * The dialect the suite is *running* as comes from the ordinary `DB_*`
 * variables. The other one comes from `DB_MYSQL_*` or `DB_POSTGRES_*`, which is
 * what lets a single job reach both - in development pantry runs MySQL on 3307
 * beside Postgres on 5432, and in CI both are services on their own ports.
 */
export function connectionFor(dialect: Dialect): DialectConnection {
  const active = activeDialect() === dialect

  const value = (specific: string, fallback: string | undefined, whenUnset: string): string => {
    const scoped = process.env[specific]
    if (scoped !== undefined && scoped !== '')
      return scoped

    return active ? (fallback ?? whenUnset) : whenUnset
  }

  if (dialect === 'mysql') {
    return {
      adapter: 'mysql',
      hostname: value('DB_MYSQL_HOST', process.env.DB_HOST, '127.0.0.1'),
      port: Number(value('DB_MYSQL_PORT', process.env.DB_PORT, '3307')),
      database: value('DB_MYSQL_DATABASE', process.env.DB_DATABASE, 'reviewos'),
      username: value('DB_MYSQL_USERNAME', process.env.DB_USERNAME, 'root'),
      password: value('DB_MYSQL_PASSWORD', process.env.DB_PASSWORD, ''),
    }
  }

  return {
    adapter: 'postgres',
    hostname: value('DB_POSTGRES_HOST', process.env.DB_HOST, '127.0.0.1'),
    port: Number(value('DB_POSTGRES_PORT', process.env.DB_PORT, '5432')),
    database: value('DB_POSTGRES_DATABASE', process.env.DB_DATABASE, 'reviewos'),
    username: value('DB_POSTGRES_USERNAME', process.env.DB_USERNAME, 'postgres'),
    password: value('DB_POSTGRES_PASSWORD', process.env.DB_PASSWORD, ''),
  }
}

/**
 * The database every engine has, for connecting before creating one.
 *
 * `CREATE DATABASE` needs a session, and a session needs a database that
 * already exists. Both engines keep one for exactly this.
 */
export function adminDatabase(dialect: Dialect): string {
  return dialect === 'mysql' ? 'mysql' : 'postgres'
}
