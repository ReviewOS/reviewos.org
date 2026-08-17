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
import { normalizeImage, resolveServices, SERVICE_IMAGES, serviceEnvironment } from '../../app/Actions/Runner/services'
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
  test('the ones this runner can serve', () => {
    const decision = resolveServices([
      { name: 'db', image: 'postgres:16', env: {} },
      { name: 'cache', image: 'redis:7', env: {} },
    ])

    expect(decision.ok).toBe(true)
    expect((decision as any).services.map((one: any) => one.service)).toEqual(['postgres', 'redis'])
    expect((decision as any).services[0].port).toBe(5432)
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
    expect(resolveServices([])).toEqual({ ok: true, services: [] })
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
