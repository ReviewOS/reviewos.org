// `services:` without containers.
//
// A workflow that writes `services: { postgres: { image: postgres:16 } }` is
// asking for one thing: a database on a port before the first step runs. Every
// other forge answers with a container; this one has pantry, which starts and
// health-checks exactly these.
//
// So the image is read as *what the workflow meant* rather than as an artifact
// to fetch - and an image nothing here can serve fails the job with the image
// named, because carrying on produces a connection refused three minutes later
// in a log nobody reads to the bottom.

import { describe, expect, test } from 'bun:test'
import { credentialsFor, freePort, imageMajor, mysqlSetup, normalizeImage, pantryScope, parsePortMapping, parseServiceOptions, portIsFree, postgresSetup, resolveServices, SERVICE_IMAGES, serviceEnvironment, servicesContext, shellWords, startServices } from '../../app/Actions/Runner/services'
import { parseWorkflow, servicesFrom } from '../../app/Actions/Workflow/parse'

describe('reading the key', () => {
  test('a job\'s services survive parsing, with their names', () => {
    const parsed = parseWorkflow(`
name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: x
        ports: ['5432:5432']
      cache:
        image: redis:7-alpine
    steps:
      - run: bun test
`)

    expect(parsed.ok).toBe(true)

    const services = parsed.workflow?.jobs?.[0]?.services ?? []

    expect(services.map(one => one.name)).toEqual(['postgres', 'cache'])
    expect(services[0]!.env.POSTGRES_PASSWORD).toBe('x')
    expect(services[0]!.ports).toEqual(['5432:5432'])
  })

  test('an entry with no image is dropped rather than failing the workflow', () => {
    // The key alone says nothing about what to start, and a parse error would
    // fail a whole workflow over a line that means nothing either way.
    expect(servicesFrom({ empty: {}, real: { image: 'redis' } }).map(one => one.name)).toEqual(['real'])
  })
})

describe('what an image means', () => {
  test('registry, namespace and tag are noise', () => {
    // Nothing is being fetched. The runner is reading which piece of software
    // the workflow meant.
    expect(normalizeImage('postgres:16')).toBe('postgres')
    expect(normalizeImage('docker.io/library/postgres:16-alpine')).toBe('postgres')
    expect(normalizeImage('redis:7@sha256:abc')).toBe('redis')
    expect(normalizeImage('bitnami/postgresql')).toBe('postgresql')
  })

  test('a variant suffix is still the same program', () => {
    expect(normalizeImage('redis-stack')).toBe('redis')
  })

  test('and every mapping names a service pantry actually has', () => {
    /*
     * The list is of what people write in workflows rather than of everything
     * pantry can start - but a mapping to a service that does not exist would
     * fail at `pantry start` with the runner's own message, which is a worse
     * place to find out.
     */
    for (const [image, mapped] of Object.entries(SERVICE_IMAGES)) {
      expect({ image, service: mapped.service.length > 0 }).toEqual({ image, service: true })
      expect({ image, port: mapped.port > 0 }).toEqual({ image, port: true })
    }
  })
})

describe('resolving a job\'s services', () => {
  test('installs the Typesense package for a clean runner and honors its image version', () => {
    const decision = resolveServices([{ name: 'search', image: 'typesense/typesense:30.2', env: {} }])
    expect(decision.ok).toBe(true)
    if (!decision.ok) throw new Error(decision.reason)
    expect(decision.services[0]).toMatchObject({ service: 'typesense', package: 'typesense.org', version: '30', containerPort: 8108 })
  })

  test('the ones this runner can serve', () => {
    const decision = resolveServices([
      { name: 'db', image: 'postgres:16', env: {} },
      { name: 'cache', image: 'redis:7', env: {} },
    ])

    expect(decision.ok).toBe(true)
    expect((decision as any).services.map((one: any) => one.service)).toEqual(['postgres', 'redis'])
    // The image's own port is what `ports:` would map from. With no mapping
    // the host side is chosen when the service starts - a free port rather
    // than 5432, which on a developer's machine is somebody's database.
    expect((decision as any).services[0].containerPort).toBe(5432)
    expect((decision as any).services[0].port).toBe(0)
  })

  test('and an image it cannot refuses the job, naming the image and what it does know', () => {
    /*
     * The decision worth defending. Running the steps anyway is a connection
     * refused three minutes later, and the person debugging it has no reason
     * to suspect the `services:` line at all.
     */
    const decision = resolveServices([{ name: 'thing', image: 'ghcr.io/acme/our-own-thing:latest', env: {} }])

    expect(decision.ok).toBe(false)
    expect((decision as any).reason).toContain('ghcr.io/acme/our-own-thing:latest')
    expect((decision as any).reason).toContain('postgres')
    expect((decision as any).reason).toContain('container engine')
  })

  test('no services at all is fine, and starts nothing', () => {
    expect(resolveServices([])).toEqual({ ok: true, services: [], notes: [] })
  })
})

describe('what a step gets', () => {
  test('host, port and a URL, named after the workflow\'s own key', () => {
    /*
     * Actions gives a service container a hostname equal to its key. Here it
     * runs on the machine, so the host is loopback and the port is the
     * service's own - and `_URL` exists because half of what a job does with a
     * database is build that string.
     */
    const environment = serviceEnvironment([
      { name: 'postgres', service: 'postgres', port: 5432 },
      { name: 'my-cache', service: 'redis', port: 6379 },
    ])

    expect(environment.POSTGRES_HOST).toBe('127.0.0.1')
    expect(environment.POSTGRES_PORT).toBe('5432')
    expect(environment.POSTGRES_URL).toBe('postgres://127.0.0.1:5432')

    // A key with a hyphen is still a usable variable name.
    expect(environment.MY_CACHE_URL).toBe('redis://127.0.0.1:6379')
  })
})

/*
 * The hq.training CI block, as written for GitHub. Everything below is what
 * this runner has to read out of it for the steps - which connect to
 * `127.0.0.1:5432` as `training` - to work unchanged.
 */
const HQ_TRAINING = {
  name: 'postgres',
  image: 'mirror.gcr.io/library/postgres:17-alpine',
  env: { POSTGRES_DB: 'training', POSTGRES_USER: 'training', POSTGRES_PASSWORD: 'training' },
  ports: ['5432:5432'],
  options: '--health-cmd "pg_isready -U training -d training" --health-interval 5s --health-timeout 3s --health-retries 12',
}

describe('the version an image asks for', () => {
  test('is the tag\'s major, whatever the variant', () => {
    expect(imageMajor('mirror.gcr.io/library/postgres:17-alpine')).toBe('17')
    expect(imageMajor('postgres:16.4')).toBe('16')
    expect(imageMajor('redis:7.2-alpine')).toBe('7')
    expect(imageMajor('postgres:17')).toBe('17')
  })

  test('and nothing when the tag names no version', () => {
    expect(imageMajor('postgres')).toBeNull()
    expect(imageMajor('postgres:latest')).toBeNull()
    expect(imageMajor('postgres:alpine')).toBeNull()
    expect(imageMajor('postgres@sha256:0123abcd')).toBeNull()
  })

  test('a registry port is not a tag', () => {
    // `localhost:5000/postgres:17` is a Postgres 17 from a registry on 5000.
    expect(imageMajor('localhost:5000/postgres:17')).toBe('17')
    expect(normalizeImage('localhost:5000/postgres:17')).toBe('postgres')
    expect(normalizeImage('mirror.gcr.io/library/postgres:17-alpine')).toBe('postgres')
  })
})

describe('ports', () => {
  test('every shape Docker takes', () => {
    expect(parsePortMapping('5432:5432')).toEqual({ host: 5432, container: 5432 })
    expect(parsePortMapping('15432:5432')).toEqual({ host: 15432, container: 5432 })
    expect(parsePortMapping('5432')).toEqual({ host: null, container: 5432 })
    expect(parsePortMapping('127.0.0.1:5432:5432')).toEqual({ host: 5432, container: 5432 })
    expect(parsePortMapping('5432:5432/tcp')).toEqual({ host: 5432, container: 5432 })
    expect(parsePortMapping('0:5432')).toEqual({ host: null, container: 5432 })
    expect(parsePortMapping('127.0.0.1::5432')).toEqual({ host: null, container: 5432 })
  })

  test('and null for what is not a port', () => {
    expect(parsePortMapping('postgres')).toBeNull()
    expect(parsePortMapping('99999:5432')).toBeNull()
    expect(parsePortMapping('')).toBeNull()
  })

  test('a bare number survives parsing, which YAML reads as a number', () => {
    expect(servicesFrom({ db: { image: 'postgres', ports: [5432, '6543:5432'] } })[0]!.ports).toEqual(['5432', '6543:5432'])
  })
})

describe('options', () => {
  test('the health flags are read, quotes and all', () => {
    const { health, ignored } = parseServiceOptions(HQ_TRAINING.options)

    expect(health).toEqual({ command: 'pg_isready -U training -d training', intervalMs: 5000, timeoutMs: 3000, retries: 12, startPeriodMs: 0 })
    expect(ignored).toEqual([])
  })

  test('the `=` form and Go durations', () => {
    const { health } = parseServiceOptions('--health-cmd=\'redis-cli ping\' --health-interval=1m30s --health-start-period 500ms')

    expect(health.command).toBe('redis-cli ping')
    expect(health.intervalMs).toBe(90_000)
    expect(health.startPeriodMs).toBe(500)
  })

  test('a container flag is named as ignored rather than dropped', () => {
    expect(parseServiceOptions('--tmpfs /var/lib/postgresql/data --rm').ignored).toEqual(['--tmpfs /var/lib/postgresql/data', '--rm'])
  })

  test('words split like a shell would', () => {
    expect(shellWords('a "b c" \'d e\' f\\ g')).toEqual(['a', 'b c', 'd e', 'f g'])
  })

  test('options survive parsing', () => {
    expect(servicesFrom({ db: { image: 'postgres', options: '--health-retries 5' } })[0]!.options).toBe('--health-retries 5')
  })
})

describe('the hq.training postgres service', () => {
  const decision = resolveServices([HQ_TRAINING])
  const service = (decision as any).services?.[0]

  test('resolves to a pinned Postgres 17 on 5432', () => {
    expect(decision.ok).toBe(true)
    expect((decision as any).notes).toEqual([])
    expect(service).toMatchObject({
      name: 'postgres',
      service: 'postgres',
      port: 5432,
      containerPort: 5432,
      pinned: true,
      version: '17',
      package: 'postgresql.org',
    })
  })

  test('creates the role and the database the steps connect with', () => {
    expect(service.credentials).toEqual({ user: 'training', password: 'training', database: 'training' })
    expect(postgresSetup(service.credentials)).toEqual([
      'CREATE ROLE "training" WITH LOGIN SUPERUSER PASSWORD \'training\'',
      'CREATE DATABASE "training" OWNER "training"',
    ])
  })

  test('and tells a step where it is, credentials included', () => {
    const environment = serviceEnvironment([{ ...service, port: 5432 }])

    expect(environment.POSTGRES_URL).toBe('postgres://training:training@127.0.0.1:5432/training')
    expect(servicesContext([service]).postgres!.ports).toEqual({ 5432: '5432' })
  })
})

describe('credentials, the way the images default them', () => {
  test('Postgres defaults the user to postgres and the database to the user', () => {
    expect(credentialsFor('postgres', {})).toEqual({ user: 'postgres', password: '', database: 'postgres' })
    expect(credentialsFor('postgres', { POSTGRES_USER: 'app' })).toEqual({ user: 'app', password: '', database: 'app' })
  })

  test('the built-in superuser is given a password rather than created again', () => {
    expect(postgresSetup({ user: 'postgres', password: 'secret', database: 'postgres' })).toEqual([
      'ALTER ROLE "postgres" WITH PASSWORD \'secret\'',
    ])
    expect(postgresSetup({ user: 'postgres', password: '', database: 'postgres' })).toEqual([])
  })

  test('names and passwords are quoted, not spliced', () => {
    expect(postgresSetup({ user: 'we"ird', password: 'it\'s', database: 'd' })).toEqual([
      'CREATE ROLE "we""ird" WITH LOGIN SUPERUSER PASSWORD \'it\'\'s\'',
      'CREATE DATABASE "d" OWNER "we""ird"',
    ])
  })

  test('MySQL creates what it was asked for, and sets the root password last', () => {
    const credentials = credentialsFor('mysql', { MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'pw', MYSQL_ROOT_PASSWORD: 'root' })

    expect(credentials).toEqual({ user: 'app', password: 'pw', database: 'app' })

    const statements = mysqlSetup(credentials!, 'root')

    expect(statements[0]).toBe('CREATE DATABASE IF NOT EXISTS `app`')
    expect(statements).toContain('GRANT ALL PRIVILEGES ON `app`.* TO \'app\'@\'%\'')
    expect(statements.at(-1)).toBe('ALTER USER \'root\'@\'localhost\' IDENTIFIED BY \'root\'')
  })

  test('Redis has no such idea', () => {
    expect(credentialsFor('redis', { REDIS_PASSWORD: 'x' })).toBeNull()

    const decision = resolveServices([{ name: 'cache', image: 'redis:7-alpine', env: {}, ports: ['6379:6379'] }])

    expect((decision as any).services[0]).toMatchObject({ service: 'redis', port: 6379, pinned: true, version: '7', package: 'redis.io', credentials: null })
  })
})

describe('two jobs, one runner', () => {
  test('a service with no host port is given its own', () => {
    const decision = resolveServices([{ ...HQ_TRAINING, ports: ['5432'] }])

    expect((decision as any).services[0]).toMatchObject({ pinned: false, port: 0, containerPort: 5432 })
  })

  test('two services cannot pin the same host port', () => {
    const decision = resolveServices([
      { name: 'one', image: 'postgres', env: {}, ports: ['5432:5432'] },
      { name: 'two', image: 'postgres', env: {}, ports: ['5432:5432'] },
    ])

    expect(decision.ok).toBe(false)
    expect((decision as any).reason).toContain('both ask for host port 5432')
  })

  test('an extra mapping is named rather than dropped', () => {
    const decision = resolveServices([{ name: 'mq', image: 'rabbitmq:3', env: {}, ports: ['5672:5672', '15672:15672'] }])

    expect((decision as any).notes.join('\n')).toContain('15672')
  })

  test('a pinned port somebody else holds fails the job, saying how to fix it', async () => {
    const holder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })

    try {
      expect(await portIsFree(holder.port)).toBe(false)

      const decision = resolveServices([{ ...HQ_TRAINING, ports: [`${holder.port}:5432`] }])
      const outcome = await startServices((decision as any).services, () => {})

      expect(outcome.ok).toBe(false)
      expect((outcome as any).reason).toContain(`host port ${holder.port}`)
      expect((outcome as any).reason).toContain('somebody else\'s data')
      expect((outcome as any).reason).toContain('job.services.postgres.ports')
      // Nothing was started, so there is nothing to put away.
      expect(outcome.services).toEqual([])
    }
    finally {
      holder.stop(true)
    }
  })

  test('a free port is free', async () => {
    expect(await portIsFree(freePort())).toBe(true)
  })
})

describe('pantry\'s project scope', () => {
  test('is the id pantry itself gives a project', () => {
    // Read from `pantry services:ports`, which lists each project's id beside
    // its path. Reproducing it is how a job finds - and removes - its data.
    expect(pantryScope('/Users/chris/Code/Apps/reviewos.org')).toBe('0c45ba56')
    expect(pantryScope('/Users/chris/Code/Apps/hq.training')).toBe('61fd0a51')
  })
})
