/**
 * `services:` on a job, started with pantry rather than with Docker.
 *
 * A workflow that writes `services: { postgres: { image: postgres:16 } }` is
 * asking for one thing: a database on a port before the first step runs. Every
 * forge answers that with a container, and this one does not have containers -
 * it has pantry, which can start and health-check sixty-eight of exactly these.
 *
 * So the image name is read as **what the workflow meant**, not as an artifact
 * to fetch. `postgres:16`, `postgres:16-alpine` and `docker.io/library/postgres`
 * are all "a Postgres, please", and pantry starts one.
 *
 * "What the workflow meant" is more than the program, though, and reading only
 * the program is how a real workflow failed here. The same block says:
 *
 * - **which version** - `postgres:17-alpine` is a Postgres 17, and a test suite
 *   written against 17 is not obliged to pass on whatever the machine has;
 * - **who connects** - `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`
 *   are how the official images are told to create a role and a database, and
 *   the steps then connect as that role, to that database;
 * - **where** - `ports: ['5432:5432']` pins the host port the steps were
 *   written against (`DB_PORT=5432`);
 * - **when it is ready** - `options: --health-cmd ... --health-retries 12`.
 *
 * All four are honoured below, each in the form a host service can honour it.
 *
 * **Every job gets its own service**, in a pantry project of its own: its own
 * data directory, its own port, removed when the job ends. Pantry's services
 * are otherwise the machine's - a developer's database, another project's
 * cache - and a job that wrote to one of those would be running its migrations
 * against somebody else's data.
 *
 * **An image nothing here can serve fails the job, with the image named.** That
 * is the decision worth defending: running the steps anyway produces a
 * connection refused three minutes later, in a log nobody reads to the bottom,
 * and the person debugging it has no reason to suspect the service line at all.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/** What a job asked for, after `services:` is parsed. */
export interface ServiceRequest {
  /** The key in the workflow, which is also the hostname Actions would give it. */
  name: string
  /** The image as written, kept for the message when this cannot be served. */
  image: string
  /** `env:` on the service, already interpolated. */
  env: Record<string, string>
  /** `ports:` as written: `5432:5432`, `5432`, `127.0.0.1:5432:5432/tcp`. */
  ports?: readonly string[]
  /** `options:` as written - Docker's flags, of which the health checks matter here. */
  options?: string
}

/** Docker's `--health-*` flags, read for their timing and their command. */
export interface HealthCheck {
  /** `--health-cmd`, run on the host with the client tools pointed at this service. */
  command: string | null
  intervalMs: number
  timeoutMs: number
  retries: number
  startPeriodMs: number
}

/** Who a database service creates and lets in, from the image's own variables. */
export interface ServiceCredentials {
  user: string
  password: string
  database: string
}

export interface ResolvedService {
  name: string
  /** The pantry service to start. */
  service: string
  /**
   * Where a step reaches it, on the host.
   *
   * Zero until it is started when the workflow did not pin one: the runner
   * then picks a free port, so two jobs on one machine never meet on the same
   * default.
   */
  port: number
  /**
   * The port the image listens on inside its container.
   *
   * What `ports:` maps *from*, and what `job.services.<id>.ports` is keyed by -
   * so `${{ job.services.postgres.ports['5432'] }}` reads the host port here
   * exactly as it does on Actions.
   */
  containerPort: number
  /** True when `ports:` named the host port, so it is that port or nothing. */
  pinned: boolean
  /** The major version the image's tag asked for, or null for the current one. */
  version: string | null
  /** The pantry package that provides it, when a version can be pinned at all. */
  package: string | null
  /** The role and database a step connects with, for a database service. */
  credentials: ServiceCredentials | null
  /** `MYSQL_ROOT_PASSWORD`, for a MySQL-shaped service that was given one. */
  rootPassword: string | null
  health: HealthCheck
}

/**
 * Image names to pantry services, the ports they listen on, and the package
 * that provides each when a version has to be pinned.
 *
 * The list is deliberately of *what people write in workflows* rather than of
 * everything pantry can start: a workflow that names `bitnami/postgresql` means
 * Postgres, and one that names something nobody has heard of should get a
 * refusal rather than a guess. Extending it is one line, which is the point.
 *
 * `package` is null where the pantry package is not one this runner has
 * checked. A tag on one of those starts the version pantry already has, and
 * the log says so rather than pretending the tag was honoured.
 */
export const SERVICE_IMAGES: Record<string, { service: string, port: number, package?: string }> = {
  'postgres': { service: 'postgres', port: 5432, package: 'postgresql.org' },
  'postgresql': { service: 'postgres', port: 5432, package: 'postgresql.org' },
  'redis': { service: 'redis', port: 6379, package: 'redis.io' },
  'valkey': { service: 'valkey', port: 6379, package: 'valkey.io' },
  'mysql': { service: 'mysql', port: 3306, package: 'mysql.com' },
  'mariadb': { service: 'mariadb', port: 3306 },
  'mongo': { service: 'mongodb', port: 27017, package: 'mongodb.com' },
  'mongodb': { service: 'mongodb', port: 27017, package: 'mongodb.com' },
  'memcached': { service: 'memcached', port: 11211, package: 'memcached.org' },
  'elasticsearch': { service: 'elasticsearch', port: 9200 },
  'opensearch': { service: 'opensearch', port: 9200 },
  'meilisearch': { service: 'meilisearch', port: 7700 },
  'typesense': { service: 'typesense', port: 8108 },
  'clickhouse': { service: 'clickhouse', port: 8123 },
  'cockroachdb': { service: 'cockroachdb', port: 26257 },
  'influxdb': { service: 'influxdb', port: 8086 },
  'rabbitmq': { service: 'rabbitmq', port: 5672 },
  'kafka': { service: 'kafka', port: 9092 },
  'nats': { service: 'nats', port: 4222 },
  'minio': { service: 'minio', port: 9000 },
  'localstack': { service: 'localstack', port: 4566 },
}

export type ServiceDecision =
  /** `notes` are what was read and not honoured, for the job's log. */
  | { ok: true, services: ResolvedService[], notes: string[] }
  /** Nothing was started. `reason` is what the job's log says before it fails. */
  | { ok: false, reason: string }

/**
 * What to start for a job, or why the job cannot run.
 *
 * Pure, because this is the part that decides whether a build fails - and a
 * rule that can only be tested by starting a database is one nobody tests
 * against `ghcr.io/acme/our-own-thing:latest`.
 */
export function resolveServices(requests: readonly ServiceRequest[]): ServiceDecision {
  const resolved: ResolvedService[] = []
  const notes: string[] = []
  const claimed = new Map<number, string>()

  for (const request of requests) {
    const known = SERVICE_IMAGES[normalizeImage(request.image)]

    if (!known) {
      return {
        ok: false,
        reason: `This runner starts services with pantry rather than containers, and nothing here serves \`${request.image}\`. `
          + `Known: ${[...new Set(Object.keys(SERVICE_IMAGES))].sort().join(', ')}. `
          + 'A job that needs an arbitrary image needs a runner with a container engine, which this is not.',
      }
    }

    const mappings = (request.ports ?? []).map(parsePortMapping)
    const unreadable = (request.ports ?? []).filter((_, index) => mappings[index] === null)

    if (unreadable.length > 0)
      return { ok: false, reason: `\`${request.name}\` has a port this runner cannot read: ${unreadable.map(one => `\`${one}\``).join(', ')}. Write it as \`host:container\` or \`container\`.` }

    const readable = mappings.filter((one): one is PortMapping => one !== null)

    /*
     * The mapping for the port the service actually listens on.
     *
     * A host service listens on one port, so one mapping can be honoured. The
     * one whose container side is the image's own port is the one the workflow
     * means; failing that, a single mapping is unambiguous whatever its
     * numbers. Anything else is named in the log rather than dropped quietly.
     */
    const main = readable.find(one => one.container === known.port) ?? (readable.length === 1 ? readable[0]! : null)

    for (const extra of readable.filter(one => one !== main))
      notes.push(`${request.name}: \`ports\` also maps ${extra.container}, and a service on the host listens on one port, so only ${main?.container ?? known.port} is mapped.`)

    const pinned = main?.host ?? null

    if (pinned !== null) {
      const holder = claimed.get(pinned)

      if (holder)
        return { ok: false, reason: `\`${holder}\` and \`${request.name}\` both ask for host port ${pinned}, and two services cannot listen on one port.` }

      claimed.set(pinned, request.name)
    }

    const version = imageMajor(request.image)

    if (version && !known.package)
      notes.push(`${request.name}: \`${request.image}\` names version ${version}, and this runner cannot pin a version of ${known.service} - it starts the one pantry has.`)

    const options = parseServiceOptions(request.options ?? '')

    for (const ignored of options.ignored)
      notes.push(`${request.name}: \`options: ${ignored}\` is a container flag, and there is no container to give it to.`)

    resolved.push({
      name: request.name,
      service: known.service,
      port: pinned ?? 0,
      containerPort: main?.container ?? known.port,
      pinned: pinned !== null,
      version,
      package: known.package ?? null,
      credentials: credentialsFor(known.service, request.env),
      rootPassword: rootPasswordFor(known.service, request.env),
      health: options.health,
    })
  }

  return { ok: true, services: resolved, notes }
}

/**
 * `docker.io/library/postgres:16-alpine` down to `postgres`.
 *
 * Registry, namespace and tag are all noise here: the runner is not fetching
 * anything, it is reading which piece of software the workflow meant.
 */
export function normalizeImage(image: string): string {
  const last = imageParts(image).name

  if (!last)
    return ''

  /*
   * `postgres-16`, `redis-stack`, `bitnami/postgresql` - the suffix people put
   * on an image name is a variant, not a different program. Matched longest
   * first so `postgresql` does not lose to `postgres`.
   */
  if (SERVICE_IMAGES[last])
    return last

  const known = Object.keys(SERVICE_IMAGES).sort((one, two) => two.length - one.length)

  return known.find(name => last.startsWith(`${name}-`) || last.startsWith(`${name}_`)) ?? last
}

/**
 * An image reference's last path segment and its tag.
 *
 * The tag is what follows the last `:` *after the last `/`*, because a
 * registry can carry a port - `localhost:5000/postgres:17` is a Postgres 17
 * from a registry on 5000, not version `5000/postgres`.
 */
function imageParts(image: string): { name: string, tag: string } {
  const text = String(image ?? '').trim().toLowerCase().split('@')[0]!
  const slash = text.lastIndexOf('/')
  const last = text.slice(slash + 1)
  const colon = last.indexOf(':')

  return colon === -1
    ? { name: last, tag: '' }
    : { name: last.slice(0, colon), tag: last.slice(colon + 1) }
}

/**
 * The major version an image's tag names, or null when it names none.
 *
 * `17-alpine`, `17.2`, `17` and `17-bookworm` are all 17. `latest`, `alpine`
 * and no tag at all are "whatever is current", which is null rather than a
 * guess. Only the major is read: pinning `17.2` exactly would fail the day
 * pantry moves to `17.3`, and no workflow writing `postgres:17.2` meant that.
 */
export function imageMajor(image: string): string | null {
  return /^v?(\d+)(?:[.\-_]|$)/.exec(imageParts(image).tag)?.[1] ?? null
}

interface PortMapping {
  host: number | null
  container: number
}

/**
 * One `ports:` entry, in any of the shapes Docker takes.
 *
 * `5432:5432` pins the host port; `5432` alone asks for a container port and
 * lets the host side be anything, which on Actions is a random port and here
 * is a free one. An address in front - `127.0.0.1:5432:5432` - is accepted and
 * ignored, because the service listens on loopback either way. Null for
 * anything that is not one of these, so the caller can name it.
 */
export function parsePortMapping(text: string): PortMapping | null {
  const parts = String(text ?? '').trim().replace(/\/(?:tcp|udp|sctp)$/i, '').split(':')
  const numbers = parts.map(part => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
  const valid = (port: number) => Number.isInteger(port) && port > 0 && port < 65536

  if (parts.length === 1 && valid(numbers[0]!))
    return { host: null, container: numbers[0]! }

  if (parts.length === 2 || parts.length === 3) {
    const host = parts.length === 2 ? numbers[0]! : numbers[1]!
    const container = numbers[parts.length - 1]!

    if (!valid(container))
      return null

    // `:5432` and `0:5432` both mean "any host port".
    if (parts[parts.length - 2] === '' || host === 0)
      return { host: null, container }

    return valid(host) ? { host, container } : null
  }

  return null
}

/**
 * `options:` - Docker flags, of which the health checks have a meaning here.
 *
 * The defaults are Docker's own, except where Docker's would make a runner
 * worse: a thirty-second interval between checks is a thirty-second wait
 * before the first step of every job, so the interval only spaces out the
 * health *command*, never the protocol check underneath it.
 */
export function parseServiceOptions(options: string): { health: HealthCheck, ignored: string[] } {
  const words = shellWords(options)
  const health: HealthCheck = { command: null, intervalMs: 30_000, timeoutMs: 30_000, retries: 3, startPeriodMs: 0 }
  const ignored: string[] = []

  for (let index = 0; index < words.length; index++) {
    const word = words[index]!

    if (!word.startsWith('-'))
      continue

    const equals = word.indexOf('=')
    const flag = equals === -1 ? word : word.slice(0, equals)

    // A flag's value is the next word, or what follows `=`. A flag that
    // takes none (`--rm`) is followed by another flag.
    const takeValue = (): string => {
      if (equals !== -1)
        return word.slice(equals + 1)

      const next = words[index + 1]

      if (next === undefined || next.startsWith('--'))
        return ''

      index++

      return next
    }

    switch (flag) {
      case '--health-cmd':
        health.command = takeValue() || null
        break
      case '--health-interval':
        health.intervalMs = durationMs(takeValue(), health.intervalMs)
        break
      case '--health-timeout':
        health.timeoutMs = durationMs(takeValue(), health.timeoutMs)
        break
      case '--health-start-period':
        health.startPeriodMs = durationMs(takeValue(), health.startPeriodMs)
        break
      case '--health-retries': {
        const retries = Number(takeValue())
        health.retries = Number.isInteger(retries) && retries > 0 ? retries : health.retries
        break
      }
      case '--health-start-interval':
        takeValue()
        break
      default: {
        const value = takeValue()
        ignored.push(value ? `${flag} ${value}` : flag)
      }
    }
  }

  return { health, ignored }
}

/** `--health-interval 5s` and friends: Go's duration syntax, in milliseconds. */
function durationMs(text: string, fallback: number): number {
  const units: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  const pieces = [...String(text).trim().matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)]

  if (pieces.length === 0 || pieces.map(piece => piece[0]).join('') !== String(text).trim())
    return fallback

  return Math.round(pieces.reduce((total, piece) => total + Number(piece[1]) * units[piece[2]!]!, 0))
}

/**
 * A string split the way a shell would split it, quotes and all.
 *
 * `--health-cmd "pg_isready -U training"` is one flag and one value, and a
 * split on spaces would make `-U` look like the next flag.
 */
export function shellWords(text: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  let started = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!

    if (quote) {
      if (char === quote)
        quote = null
      else if (char === '\\' && quote === '"' && index + 1 < text.length)
        current += text[++index]
      else
        current += char

      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      started = true
      continue
    }

    if (char === '\\' && index + 1 < text.length) {
      current += text[++index]
      started = true
      continue
    }

    if (/\s/.test(char)) {
      if (started)
        words.push(current)

      current = ''
      started = false
      continue
    }

    current += char
    started = true
  }

  if (started)
    words.push(current)

  return words
}

/**
 * The role and database a database image would have created.
 *
 * The official images' own rules, so a workflow written for them connects
 * here with the same credentials: Postgres defaults the user to `postgres` and
 * the database to the user; MySQL creates a database only when asked, and a
 * user only when given one. Null for a service with no such idea.
 *
 * `variables` rather than `env`, because the configuration page lists every
 * variable read off an `env` object as something an operator sets - and these are
 * the workflow's, not this instance's.
 */
export function credentialsFor(service: string, variables: Record<string, string>): ServiceCredentials | null {
  if (service === 'postgres') {
    const user = variables.POSTGRES_USER || 'postgres'

    return { user, password: variables.POSTGRES_PASSWORD ?? '', database: variables.POSTGRES_DB || user }
  }

  if (service === 'mysql' || service === 'mariadb') {
    const pick = (name: string) => variables[`MYSQL_${name}`] ?? variables[`MARIADB_${name}`] ?? ''

    return { user: pick('USER') || 'root', password: pick('PASSWORD') || pick('ROOT_PASSWORD'), database: pick('DATABASE') }
  }

  return null
}

/** `MYSQL_ROOT_PASSWORD`, or MariaDB's spelling of it, for a MySQL-shaped service. */
function rootPasswordFor(service: string, variables: Record<string, string>): string | null {
  if (service !== 'mysql' && service !== 'mariadb')
    return null

  return variables.MYSQL_ROOT_PASSWORD ?? variables.MARIADB_ROOT_PASSWORD ?? null
}

/** A Postgres identifier, quoted, so a role called `user` is a role and not a keyword. */
export function postgresIdentifier(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`
}

/** A Postgres string literal. `standard_conforming_strings` is on, so only quotes need doubling. */
export function postgresLiteral(value: string): string {
  return `'${String(value).replace(/'/g, '\'\'')}'`
}

/**
 * The statements that make a fresh Postgres cluster look like the official
 * image's after it read `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`.
 *
 * The role is a superuser, as it is in the image: that role *is* the image's
 * superuser, and a suite whose migrations create an extension relies on it.
 * Run as pantry's own `postgres` superuser, against a cluster this job created
 * moments ago, so there is nothing to check for first.
 */
export function postgresSetup(credentials: ServiceCredentials): string[] {
  const statements: string[] = []
  const role = postgresIdentifier(credentials.user)
  const password = credentials.password ? ` PASSWORD ${postgresLiteral(credentials.password)}` : ''

  if (credentials.user === 'postgres') {
    if (password)
      statements.push(`ALTER ROLE ${role} WITH${password}`)
  }
  else {
    statements.push(`CREATE ROLE ${role} WITH LOGIN SUPERUSER${password}`)
  }

  if (credentials.database !== 'postgres')
    statements.push(`CREATE DATABASE ${postgresIdentifier(credentials.database)} OWNER ${role}`)

  return statements
}

/** A MySQL identifier in backticks. */
function mysqlIdentifier(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``
}

/** A MySQL string literal. Backslashes escape by default, so they are doubled too. */
function mysqlLiteral(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, '\'\'')}'`
}

/**
 * The same for a MySQL-shaped image: `MYSQL_DATABASE`, `MYSQL_USER` with
 * `MYSQL_PASSWORD`, and `MYSQL_ROOT_PASSWORD`.
 *
 * The root password goes last, because every statement before it runs as a
 * root with no password - which is how pantry initialises the server.
 */
export function mysqlSetup(credentials: ServiceCredentials, rootPassword: string | null): string[] {
  const statements: string[] = []

  if (credentials.database)
    statements.push(`CREATE DATABASE IF NOT EXISTS ${mysqlIdentifier(credentials.database)}`)

  if (credentials.user && credentials.user !== 'root') {
    statements.push(`CREATE USER IF NOT EXISTS ${mysqlLiteral(credentials.user)}@'%' IDENTIFIED BY ${mysqlLiteral(credentials.password)}`)

    if (credentials.database)
      statements.push(`GRANT ALL PRIVILEGES ON ${mysqlIdentifier(credentials.database)}.* TO ${mysqlLiteral(credentials.user)}@'%'`)
  }

  if (rootPassword) {
    statements.push(`CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY ${mysqlLiteral(rootPassword)}`)
    statements.push(`GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION`)
    statements.push(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${mysqlLiteral(rootPassword)}`)
  }

  return statements
}

/** What a step needs to reach a service: where it is, and who to be. */
type ServiceAddress = Pick<ResolvedService, 'name' | 'service' | 'port'> & { credentials?: ServiceCredentials | null }

/**
 * The environment a step gets for a service.
 *
 * Actions gives a service container a hostname equal to its key. Here the
 * service runs on the machine, so the *host* is loopback and the port is the
 * one this job's service listens on - and the variables are named after the
 * key so a workflow can be written once and read either way:
 *
 *     ${{ job.services.postgres.ports['5432'] }}   # Actions, and here
 *     $POSTGRES_HOST, $POSTGRES_PORT               # here
 *
 * `<KEY>_URL` is there because half of what a job does with a database is build
 * that string, and every workflow that lacks it writes the same interpolation.
 * It carries the credentials the service was created with, when it has any.
 */
export function serviceEnvironment(services: readonly ServiceAddress[]): Record<string, string> {
  const environment: Record<string, string> = {}

  for (const service of services) {
    const prefix = service.name.replace(/[^a-z0-9]+/gi, '_').toUpperCase()

    environment[`${prefix}_HOST`] = '127.0.0.1'
    environment[`${prefix}_PORT`] = String(service.port)
    environment[`${prefix}_URL`] = urlFor(service)
  }

  return environment
}

/**
 * `job.services`, in the shape Actions gives it.
 *
 * `ports` maps the container port to the host one, as strings, which is what
 * `${{ job.services.postgres.ports['5432'] }}` reads.
 */
export function servicesContext(services: readonly ResolvedService[]): Record<string, { id: string, network: string, ports: Record<string, string> }> {
  const context: Record<string, { id: string, network: string, ports: Record<string, string> }> = {}

  for (const service of services)
    context[service.name] = { id: service.name, network: '', ports: { [String(service.containerPort)]: String(service.port) } }

  return context
}

function urlFor(service: ServiceAddress): string {
  const scheme = service.service === 'postgres'
    ? 'postgres'
    : service.service === 'mysql' || service.service === 'mariadb'
      ? 'mysql'
      : service.service === 'mongodb'
        ? 'mongodb'
        : service.service === 'redis' || service.service === 'valkey'
          ? 'redis'
          : 'http'

  const credentials = service.credentials

  if (!credentials || !credentials.user)
    return `${scheme}://127.0.0.1:${service.port}`

  const auth = credentials.password
    ? `${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@`
    : `${encodeURIComponent(credentials.user)}@`

  return `${scheme}://${auth}127.0.0.1:${service.port}${credentials.database ? `/${encodeURIComponent(credentials.database)}` : ''}`
}

/**
 * Whether something is listening yet.
 *
 * A service that has been *started* is not a service that is *ready*, and the
 * gap is where flaky CI comes from: Postgres accepts connections a second or
 * two after the process exists, so a first step that connects immediately fails
 * on a fast machine and passes on a slow one.
 */
export async function waitForPort(port: number, deadlineMs = 30_000, now: () => number = Date.now): Promise<boolean> {
  const until = now() + deadlineMs

  while (now() < until) {
    if (await listening(port))
      return true

    await Bun.sleep(250)
  }

  return false
}

/** Whether anything accepts a connection on this loopback port right now. */
async function listening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { data() {}, error() {} },
    })

    socket.end()

    return true
  }
  catch {
    return false
  }
}

/**
 * Whether this runner may open a service on `port`.
 *
 * Asked by binding it, not by connecting to it: a server bound to every
 * interface answers a connect on loopback too, but one that is starting up
 * does not answer yet - and binding is the question the service is about to
 * ask anyway.
 */
export async function portIsFree(port: number): Promise<boolean> {
  if (await listening(port))
    return false

  try {
    const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })

    server.stop(true)

    return true
  }
  catch {
    return false
  }
}

/** A port nothing is listening on, chosen by the operating system. */
export function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = server.port

  server.stop(true)

  return port
}

/* ------------------------------------------------------------- lifecycle */

/** A service this job started, and what it takes to put it away again. */
export interface StartedService extends ResolvedService {
  /** The pantry project the service was started from, which scopes it to this job. */
  directory: string
  /** Pantry's data directory for that project, when this job created it. */
  dataDirectory: string | null
  /** Where the service's own client tools are, for a health command. */
  binDirectory: string
}

export type StartOutcome =
  | { ok: true, services: StartedService[] }
  | { ok: false, reason: string, services: StartedService[] }

/**
 * Pantry's id for a project, which names that project's data directory.
 *
 * Pantry's own function, reproduced - 64-bit FNV-1a over the project's real
 * path, cut to 32 bits - because it is the only way to find the directory a
 * job's database wrote to, and a job that leaves a cluster behind on every run
 * fills a runner's disk in a week.
 */
export function pantryScope(projectRoot: string): string {
  let hash = 0xCBF29CE484222325n

  for (const byte of new TextEncoder().encode(projectRoot)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001B3n) & 0xFFFFFFFFFFFFFFFFn
  }

  return (hash & 0xFFFFFFFFn).toString(16).padStart(8, '0')
}

/** Where pantry keeps a project's service data. */
function pantryDataRoot(scope: string): string {
  // As root on Linux, pantry keeps service data where a service that drops
  // privileges can still reach it, rather than under `/root`.
  if (process.platform === 'linux' && process.getuid?.() === 0)
    return join('/var/lib/pantry', scope)

  return join(homedir(), '.local', 'share', 'pantry', 'data', scope)
}

/** Run pantry in a directory and collect what it said. */
async function pantry(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean, output: string }> {
  try {
    const child = Bun.spawn(['pantry', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env as Record<string, string> })
    const timer = setTimeout(() => child.kill(), timeoutMs)

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    clearTimeout(timer)

    return { ok: code === 0, output: `${stdout}${stderr}`.trim() }
  }
  catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The part of a tool's output that says what went wrong.
 *
 * The lines that name an error, when there are any, and the last few
 * otherwise. Pantry prints the package that failed in the middle of a list of
 * the seventeen that did not, and a tail alone ends with "1 package(s) failed"
 * - which is true and names nothing.
 */
export function tail(text: string, lines = 6): string {
  const all = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim())
  const errors = all.filter(line => /\b(?:error|failed|not found|unknown)\b/i.test(line))

  return (errors.length > 0 ? errors : all).slice(-lines).join('\n')
}

/**
 * Start a job's services, each in a pantry project of its own.
 *
 * In order, and the first one that cannot be started stops the rest: a job
 * whose cache came up and whose database did not is a job that fails later
 * and more confusingly. Whatever was started is returned either way, so the
 * caller can put it away.
 */
export async function startServices(
  resolved: readonly ResolvedService[],
  say: (line: string) => Promise<void> | void,
): Promise<StartOutcome> {
  const started: StartedService[] = []

  for (const service of resolved) {
    /*
     * The port, decided before anything is installed.
     *
     * A pinned port this runner did not open is refused rather than shared.
     * Whatever holds it - another job's database, the machine's own - is not
     * this job's, and a suite that ran its migrations against it would be
     * running them against somebody else's data. An unpinned one is any free
     * port, so two jobs on one runner never meet on the same default.
     */
    const port = service.pinned ? service.port : freePort()

    if (service.pinned && !(await portIsFree(port))) {
      return {
        ok: false,
        services: started,
        reason: `\`${service.name}\` asks for host port ${port} (\`ports: ['${port}:${service.containerPort}']\`), and something on this runner is already listening there - another job's service, or a server the machine runs for itself. `
          + 'A job is never pointed at a server it did not start, because its steps would run against somebody else\'s data. '
          + `Free the port, run one such job at a time on this runner, or let the runner choose: write \`ports: ['${service.containerPort}']\` and read the port from \`$${envPrefix(service.name)}_PORT\` or \`\${{ job.services.${service.name}.ports['${service.containerPort}'] }}\`.`,
      }
    }

    /*
     * The project, in the system's temporary directory rather than in the
     * checkout: pantry finds a project by walking up from where it runs, and a
     * repository with a `package.json` declaring workspaces would claim the
     * service as its own.
     */
    const directory = realpathSync(mkdtempSync(join(tmpdir(), `reviewos-service-${envPrefix(service.name).toLowerCase()}-`)))
    const dataRoot = pantryDataRoot(pantryScope(directory))
    const owned = !existsSync(dataRoot)
    const pin = service.package ? `  ${service.package}: ${service.version ? `^${service.version}` : 'latest'}\n` : ''

    // Written even with nothing to pin: the file is what makes this directory
    // a pantry project, and so what scopes the service to this job.
    writeFileSync(join(directory, 'deps.yaml'), `# Written by the ReviewOS runner for one job's \`${service.name}\` service.\n${pin ? `dependencies:\n${pin}` : ''}`)

    const record: StartedService = {
      ...service,
      port,
      directory,
      dataDirectory: owned ? dataRoot : null,
      binDirectory: join(directory, 'pantry', '.bin'),
    }

    started.push(record)

    if (pin) {
      await say(`${service.name}: pantry install ${service.package}@${service.version ? `^${service.version}` : 'latest'}\n`)

      const installed = await pantry(['install'], directory, 10 * 60_000)

      if (!installed.ok) {
        return {
          ok: false,
          services: started,
          reason: `\`${service.name}\` needs ${service.package} ${service.version ? `${service.version}.x` : '(latest)'}, and pantry could not install it:\n${tail(installed.output)}`,
        }
      }
    }

    await say(`${service.name}: pantry start ${service.service} --port ${port}\n`)

    const start = await pantry(['start', service.service, '--port', String(port)], directory, 3 * 60_000)

    if (!start.ok) {
      return {
        ok: false,
        services: started,
        reason: `\`${service.name}\` did not start on port ${port}:\n${tail(start.output)}`,
      }
    }

    const ready = await waitUntilReady(record, say)

    if (!ready.ok)
      return { ok: false, services: started, reason: ready.reason }

    await say(`${service.name}: ready on 127.0.0.1:${port}\n`)
  }

  return { ok: true, services: started }
}

function envPrefix(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '_').toUpperCase()
}

/**
 * Ready, in the sense a step means: it can connect, as the user it will
 * connect as, to the database it will use.
 *
 * Three stages, and each is there because the one before it is not enough:
 *
 * 1. **The protocol answers.** For Postgres that is a login and `SELECT 1`,
 *    which is what `pg_isready` checks and a little more; for Redis a `PING`;
 *    for anything else, a port that accepts a connection.
 * 2. **The image's variables are applied** - the role, its password, the
 *    database - and then checked by logging in *as* that role.
 * 3. **The workflow's own `--health-cmd`**, when it gave one, run on the host
 *    with the client tools pointed at this service, retried on the interval
 *    and with the timeout it asked for. A command whose program is not on the
 *    runner is named in the log rather than failing a service that has already
 *    proved itself in stage one.
 */
async function waitUntilReady(service: StartedService, say: (line: string) => Promise<void> | void): Promise<{ ok: true } | { ok: false, reason: string }> {
  const health = service.health
  const deadlineMs = Math.max(60_000, health.startPeriodMs + (health.retries + 1) * health.intervalMs)
  const until = Date.now() + deadlineMs
  let last = ''

  while (Date.now() < until) {
    last = await probe(service, true)

    if (!last)
      break

    await Bun.sleep(500)
  }

  if (last) {
    return {
      ok: false,
      reason: `\`${service.name}\` never became ready on port ${service.port} (${last}). Check \`pantry logs ${service.service}\` from ${service.directory} on the runner.`,
    }
  }

  const setup = await applyCredentials(service)

  if (setup)
    return { ok: false, reason: `\`${service.name}\` started, and its \`env:\` could not be applied: ${setup}` }

  const asUser = await probe(service, false)

  if (asUser)
    return { ok: false, reason: `\`${service.name}\` started, and ${service.credentials?.user ?? 'its user'} cannot connect to it: ${asUser}` }

  if (!health.command)
    return { ok: true }

  /*
   * Only where the client tools can be pointed at this job's port.
   *
   * `pg_isready` and the MySQL clients read where to connect from the
   * environment. `redis-cli ping` does not: run as written it asks port 6379,
   * which on a machine with its own Redis answers for a server this job never
   * started - a health check that passes for the wrong reason. The protocol
   * check above already sent the same PING to the right port.
   */
  if (!['postgres', 'mysql', 'mariadb'].includes(service.service)) {
    await say(`${service.name}: \`--health-cmd ${health.command}\` would ask ${service.service}'s default port rather than this job's, so the protocol check above stands in for it\n`)

    return { ok: true }
  }

  const program = shellWords(health.command)[0] ?? ''
  const path = `${service.binDirectory}:${process.env.PATH ?? '/usr/bin:/bin'}`

  if (!program || !Bun.which(program, { PATH: path })) {
    await say(`${service.name}: \`--health-cmd ${health.command}\` names \`${program}\`, which this runner does not have; the protocol check above stands in for it\n`)

    return { ok: true }
  }

  await Bun.sleep(Math.min(health.startPeriodMs, 60_000))

  for (let attempt = 1; attempt <= Math.max(1, health.retries); attempt++) {
    const result = await healthCommand(service, path)

    if (result.ok) {
      await say(`${service.name}: healthy (${health.command})\n`)

      return { ok: true }
    }

    last = result.output

    if (attempt < health.retries)
      await Bun.sleep(Math.min(health.intervalMs, 30_000))
  }

  return { ok: false, reason: `\`${service.name}\` failed its health check \`${health.command}\` ${health.retries} times${last ? `: ${tail(last, 3)}` : ''}` }
}

/** One run of the workflow's health command, with the client tools aimed at this service. */
async function healthCommand(service: StartedService, path: string): Promise<{ ok: boolean, output: string }> {
  const credentials = service.credentials
  const environment: Record<string, string> = { ...(process.env as Record<string, string>), PATH: path }

  // The variables each family of client tools reads for where to connect, so
  // `pg_isready -U training` asks this job's server rather than the default
  // port - which on a developer's machine is somebody else's database.
  if (service.service === 'postgres') {
    Object.assign(environment, { PGHOST: '127.0.0.1', PGPORT: String(service.port) })

    if (credentials)
      Object.assign(environment, { PGUSER: credentials.user, PGPASSWORD: credentials.password, PGDATABASE: credentials.database })
  }

  if (service.service === 'mysql' || service.service === 'mariadb')
    Object.assign(environment, { MYSQL_HOST: '127.0.0.1', MYSQL_TCP_PORT: String(service.port) })

  try {
    const child = Bun.spawn(['sh', '-c', service.health.command!], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), service.health.timeoutMs)
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    clearTimeout(timer)

    return { ok: code === 0, output: `${stdout}${stderr}`.trim() }
  }
  catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * One readiness check. An empty string is ready; anything else is why not.
 *
 * `asAdmin` connects as the server's own superuser, before the image's
 * variables have been applied; without it, as the role the steps will use.
 */
async function probe(service: StartedService, asAdmin: boolean): Promise<string> {
  try {
    if (service.service === 'postgres') {
      const credentials = service.credentials

      const sql = new Bun.SQL({
        adapter: 'postgres',
        hostname: '127.0.0.1',
        port: service.port,
        username: asAdmin || !credentials ? 'postgres' : credentials.user,
        password: asAdmin || !credentials ? '' : credentials.password,
        database: asAdmin || !credentials ? 'postgres' : credentials.database,
        max: 1,
        connectionTimeout: 5,
      })

      try {
        await sql.unsafe('SELECT 1')
      }
      finally {
        await sql.close().catch(() => {})
      }

      return ''
    }

    if (service.service === 'mysql' || service.service === 'mariadb') {
      const credentials = service.credentials
      const admin = asAdmin || !credentials

      const sql = new Bun.SQL({
        adapter: 'mysql',
        hostname: '127.0.0.1',
        port: service.port,
        username: admin ? 'root' : credentials.user,
        password: admin ? '' : (credentials.user === 'root' ? (service.rootPassword ?? '') : credentials.password),
        database: admin ? undefined : (credentials.database || undefined),
        max: 1,
        connectionTimeout: 5,
      })

      try {
        await sql.unsafe('SELECT 1')
      }
      finally {
        await sql.close().catch(() => {})
      }

      return ''
    }

    if (service.service === 'redis' || service.service === 'valkey')
      return await redisPing(service.port)

    return (await listening(service.port)) ? '' : 'nothing is listening yet'
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** `PING`, over a bare socket, expecting `+PONG`. */
async function redisPing(port: number): Promise<string> {
  return await new Promise<string>((resolve) => {
    let answer = ''
    const timer = setTimeout(() => resolve('no answer to PING'), 3000)

    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write('PING\r\n')
        },
        data(socket, chunk) {
          answer += Buffer.from(chunk).toString()

          if (answer.includes('\r\n')) {
            clearTimeout(timer)
            socket.end()
            resolve(answer.startsWith('+PONG') ? '' : `PING answered ${answer.trim()}`)
          }
        },
        error(_socket, error) {
          clearTimeout(timer)
          resolve(error.message)
        },
      },
    }).catch((error: unknown) => {
      clearTimeout(timer)
      resolve(error instanceof Error ? error.message : String(error))
    })
  })
}

/** Apply the image's variables. An empty string is done; anything else is why not. */
async function applyCredentials(service: StartedService): Promise<string> {
  const credentials = service.credentials

  if (!credentials)
    return ''

  const postgres = service.service === 'postgres'
  const statements = postgres ? postgresSetup(credentials) : mysqlSetup(credentials, service.rootPassword)

  if (statements.length === 0)
    return ''

  const sql = new Bun.SQL({
    adapter: postgres ? 'postgres' : 'mysql',
    hostname: '127.0.0.1',
    port: service.port,
    username: postgres ? 'postgres' : 'root',
    password: '',
    database: postgres ? 'postgres' : undefined,
    max: 1,
    connectionTimeout: 5,
  })

  try {
    // One at a time and outside a transaction: `CREATE DATABASE` refuses to
    // run inside one.
    for (const statement of statements)
      await sql.unsafe(statement)

    return ''
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  finally {
    await sql.close().catch(() => {})
  }
}

/**
 * Put a job's services away: stop each, remove its unit, and delete the data
 * it wrote.
 *
 * Every step is best-effort and none of them can fail the job - its result is
 * already decided. The data directory is deleted only when this job created
 * it, which is what makes deleting it safe at all: a directory that existed
 * before the service started belongs to somebody else, however it came to
 * share the name.
 */
export async function stopServices(services: readonly StartedService[]): Promise<void> {
  for (const service of [...services].reverse()) {
    await pantry(['services:remove', service.service], service.directory, 60_000)

    if (service.dataDirectory)
      rmSync(service.dataDirectory, { recursive: true, force: true })

    rmSync(service.directory, { recursive: true, force: true })
  }
}
