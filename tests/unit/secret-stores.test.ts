// Secrets this instance never held.
//
// The roadmap's position: the best secret is one we never had. An encrypted
// column answers "where do we keep it" and nothing at all about what happens
// when the database is copied - so a secret may be a reference into the store
// an organisation already runs, read at the moment a job is handed out.
//
// Two properties matter more than the plumbing. A repository cannot name a URL,
// only a store the operator configured; and a reference that cannot be read
// fails loudly rather than arriving as an empty credential.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { configuredStores, parseReference, resolveReference } from '../../app/Actions/Workflow/secretStore'

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-stores-'))

  mkdirSync(join(root, 'mounted', 'nested'), { recursive: true })
  writeFileSync(join(root, 'mounted', 'deploy-key'), 'the-value-from-the-platform\n')
  writeFileSync(join(root, 'mounted', 'nested', 'inner'), 'nested value')

  writeFileSync(join(root, 'stores.json'), JSON.stringify({
    mounted: { kind: 'file', address: join(root, 'mounted') },
    prod: { kind: 'vault', address: 'https://vault.internal', tokenFile: join(root, 'token') },
    nonsense: { kind: 'carrier-pigeon', address: 'somewhere' },
  }))

  writeFileSync(join(root, 'token'), 'hvs.a-token\n')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a reference', () => {
  test('names a store, a path and a field', () => {
    expect(parseReference('store://prod/secret/data/deploy#DEPLOY_KEY')).toEqual({
      store: 'prod',
      path: 'secret/data/deploy',
      field: 'DEPLOY_KEY',
    })
  })

  test('is never a URL, whatever the scheme', () => {
    /*
     * The difference between "read this from the store you set up" and "fetch
     * this from an address a repository administrator typed" - the second is a
     * request this server makes from inside the network on somebody else's
     * say-so, which is the shape of every SSRF.
     */
    expect(parseReference('https://vault.internal/v1/secret/data/deploy')).toBeNull()
    expect(parseReference('http://169.254.169.254/latest/meta-data/')).toBeNull()
    expect(parseReference('file:///etc/shadow')).toBeNull()
    expect(parseReference('a plain value')).toBeNull()
  })

  test('and cannot climb', () => {
    expect(parseReference('store://mounted/../../etc/shadow')).toBeNull()
    // A store with no path is not a reference: the store is not the secret.
    expect(parseReference('store://mounted')).toBeNull()
  })
})

describe('the configured stores', () => {
  test('are read from the file the operator named, and nothing else', async () => {
    const stores = await configuredStores(join(root, 'stores.json'))

    expect(Object.keys(stores).sort()).toEqual(['mounted', 'prod'])
    // A kind this instance does not implement is dropped rather than kept as a
    // store that fails at the worst moment.
    expect(stores.nonsense).toBeUndefined()
    expect(stores.prod!.tokenFile).toContain('token')
  })

  test('and a missing file is no stores rather than an error', async () => {
    // An instance with no external store is the ordinary case, and a
    // configuration file that does not exist must not stop it booting.
    expect(await configuredStores(join(root, 'not-here.json'))).toEqual({})
    expect(await configuredStores('')).toEqual({})
  })
})

describe('resolving', () => {
  test('reads a mounted file, without the newline every editor adds', async () => {
    const stores = await configuredStores(join(root, 'stores.json'))
    const resolved = await resolveReference(parseReference('store://mounted/deploy-key')!, stores)

    expect(resolved.ok).toBe(true)
    // A credential with a trailing newline fails authentication in a way that
    // reads as the credential being wrong rather than as whitespace.
    expect(resolved.value).toBe('the-value-from-the-platform')
  })

  test('and refuses a path that climbs out of the store', async () => {
    const stores = await configuredStores(join(root, 'stores.json'))

    // Parsing catches the obvious form; this is the one that only appears after
    // the path is normalised.
    const resolved = await resolveReference({ store: 'mounted', path: 'nested/../../token', field: '' }, stores)

    expect(resolved.ok).toBe(false)
    expect(resolved.reason).toContain('climbs out')
  })

  test('reads Vault KV v2, where the values live under data.data', async () => {
    const stores = await configuredStores(join(root, 'stores.json'))
    const asked: Array<{ url: string, token: string }> = []

    const resolved = await resolveReference(
      parseReference('store://prod/secret/data/deploy#DEPLOY_KEY')!,
      stores,
      (async (url: any, init: any) => {
        asked.push({ url: String(url), token: String(init?.headers?.['X-Vault-Token'] ?? '') })

        return new Response(JSON.stringify({ data: { data: { DEPLOY_KEY: 'from-vault' } } }), { status: 200 })
      }) as any,
    )

    expect(resolved.ok).toBe(true)
    expect(resolved.value).toBe('from-vault')
    // The path as written, so what goes in a reference is what an operator
    // would type into the Vault CLI.
    expect(asked[0]!.url).toBe('https://vault.internal/v1/secret/data/deploy')
    // The token read from the file, so a rotated one is picked up without a
    // restart - and never from an environment variable that appears in `ps`.
    expect(asked[0]!.token).toBe('hvs.a-token')
  })

  test('and says what went wrong rather than returning an empty credential', async () => {
    const stores = await configuredStores(join(root, 'stores.json'))

    const refused = await resolveReference(
      parseReference('store://prod/secret/data/deploy#DEPLOY_KEY')!,
      stores,
      (async () => new Response('{}', { status: 403 })) as any,
    )

    expect(refused.ok).toBe(false)
    expect(refused.value).toBe('')
    expect(refused.reason).toContain('403')

    const missingField = await resolveReference(
      parseReference('store://prod/secret/data/deploy#NOT_THERE')!,
      stores,
      (async () => new Response(JSON.stringify({ data: { data: { OTHER: 'x' } } }), { status: 200 })) as any,
    )

    expect(missingField.ok).toBe(false)
    expect(missingField.reason).toContain('NOT_THERE')

    const unknownStore = await resolveReference({ store: 'nowhere', path: 'x', field: '' }, stores)

    expect(unknownStore.ok).toBe(false)
    expect(unknownStore.reason).toContain('nowhere')
  })

  test('and a store this instance cannot reach is a sentence, not a stack trace', async () => {
    const stores = await configuredStores(join(root, 'stores.json'))

    const resolved = await resolveReference(
      parseReference('store://prod/secret/data/deploy#KEY')!,
      stores,
      (async () => { throw new Error('connect ECONNREFUSED 10.0.0.9:8200') }) as any,
    )

    expect(resolved.ok).toBe(false)
    expect(resolved.reason).toContain('ECONNREFUSED')
  })
})
