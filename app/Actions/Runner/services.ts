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
 * **An image nothing here can serve fails the job, with the image named.** That
 * is the decision worth defending: running the steps anyway produces a
 * connection refused three minutes later, in a log nobody reads to the bottom,
 * and the person debugging it has no reason to suspect the service line at all.
 */

/** What a job asked for, after `services:` is parsed. */
export interface ServiceRequest {
  /** The key in the workflow, which is also the hostname Actions would give it. */
  name: string
  /** The image as written, kept for the message when this cannot be served. */
  image: string
  /** `env:` on the service, passed to pantry where it maps. */
  env: Record<string, string>
}

export interface ResolvedService {
  name: string
  /** The pantry service to start. */
  service: string
  /** Where a step reaches it. */
  port: number
}

/**
 * Image names to pantry services, and the ports they listen on.
 *
 * The list is deliberately of *what people write in workflows* rather than of
 * everything pantry can start: a workflow that names `bitnami/postgresql` means
 * Postgres, and one that names something nobody has heard of should get a
 * refusal rather than a guess. Extending it is one line, which is the point.
 */
export const SERVICE_IMAGES: Record<string, { service: string, port: number }> = {
  'postgres': { service: 'postgres', port: 5432 },
  'postgresql': { service: 'postgres', port: 5432 },
  'redis': { service: 'redis', port: 6379 },
  'valkey': { service: 'valkey', port: 6379 },
  'mysql': { service: 'mysql', port: 3306 },
  'mariadb': { service: 'mariadb', port: 3306 },
  'mongo': { service: 'mongodb', port: 27017 },
  'mongodb': { service: 'mongodb', port: 27017 },
  'memcached': { service: 'memcached', port: 11211 },
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
  | { ok: true, services: ResolvedService[] }
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

    resolved.push({ name: request.name, service: known.service, port: known.port })
  }

  return { ok: true, services: resolved }
}

/**
 * `docker.io/library/postgres:16-alpine` down to `postgres`.
 *
 * Registry, namespace and tag are all noise here: the runner is not fetching
 * anything, it is reading which piece of software the workflow meant.
 */
export function normalizeImage(image: string): string {
  const text = String(image ?? '').trim().toLowerCase()

  if (!text)
    return ''

  // Drop the tag or digest, then the registry and namespace.
  const withoutTag = text.split('@')[0]!.split(':')[0]!
  const last = withoutTag.split('/').pop() ?? ''

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
 * The environment a step gets for a service.
 *
 * Actions gives a service container a hostname equal to its key. Here the
 * service runs on the machine, so the *host* is loopback and the port is the
 * service's own - and the variables are named after the key so a workflow can
 * be written once and read either way:
 *
 *     ${{ job.services.postgres.ports }}   # Actions
 *     $POSTGRES_HOST, $POSTGRES_PORT       # here
 *
 * `<KEY>_URL` is there because half of what a job does with a database is build
 * that string, and every workflow that lacks it writes the same interpolation.
 */
export function serviceEnvironment(services: readonly ResolvedService[]): Record<string, string> {
  const environment: Record<string, string> = {}

  for (const service of services) {
    const prefix = service.name.replace(/[^a-z0-9]+/gi, '_').toUpperCase()

    environment[`${prefix}_HOST`] = '127.0.0.1'
    environment[`${prefix}_PORT`] = String(service.port)
    environment[`${prefix}_URL`] = urlFor(service)
  }

  return environment
}

function urlFor(service: ResolvedService): string {
  const scheme = service.service === 'postgres'
    ? 'postgres'
    : service.service === 'mysql' || service.service === 'mariadb'
      ? 'mysql'
      : service.service === 'mongodb'
        ? 'mongodb'
        : service.service === 'redis' || service.service === 'valkey'
          ? 'redis'
          : 'http'

  return `${scheme}://127.0.0.1:${service.port}`
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
      await Bun.sleep(250)
    }
  }

  return false
}
