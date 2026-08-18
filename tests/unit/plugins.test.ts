// Plugins: what a reference means, what a manifest declares, and who may run it.
//
// All three are pure, and deliberately so - the rules a plugin is judged by are
// the part that has to be readable, and a policy that could only be exercised
// by dispatching a run is one nobody would test the edges of. The wiring is
// covered end to end in `tests/e2e/workflow-plugins.test.ts`.

import { describe, expect, test } from 'bun:test'
import { parameterEnvironment, parseManifest, validateParameters } from '../../app/Actions/Plugin/manifest'
import { effectivePolicy, pluginVerdict } from '../../app/Actions/Plugin/policy'
import { isProblem, parsePluginReference, readPluginList } from '../../app/Actions/Plugin/reference'

/** A parsed reference, when the test knows it is one. */
function reference(raw: string) {
  const parsed = parsePluginReference(raw)

  if (isProblem(parsed))
    throw new Error(`expected \`${raw}\` to parse: ${parsed.reason}`)

  return parsed
}

describe('a plugin reference', () => {
  test('names a repository on this instance, or a directory in this one', () => {
    expect(reference('acme/docker-login#v1.2.0')).toMatchObject({
      kind: 'repository',
      source: 'acme/docker-login',
      name: 'docker-login',
      ref: 'v1.2.0',
      pin: 'named',
    })

    expect(reference('./.reviewos/plugins/profiler')).toMatchObject({
      kind: 'vendored',
      source: '.reviewos/plugins/profiler',
      name: 'profiler',
      // Pinned by construction: it travels with the code that uses it, so
      // there is no version to write down.
      pin: 'own-commit',
    })
  })

  test('refuses a reference to somewhere else entirely', () => {
    /*
     * The decision this defends: a plugin is code that runs outside the steps,
     * and an instance whose jobs execute whatever a third-party host serves
     * today has no boundary left to enforce.
     */
    for (const raw of ['https://example.com/plugin.git', 'git@example.com:acme/plugin.git']) {
      const parsed = parsePluginReference(raw)

      expect(isProblem(parsed)).toBe(true)
    }
  })

  test('knows a commit from a name, because only one of them is a pin', () => {
    expect(reference('acme/plugin#0123456789abcdef0123456789abcdef01234567').pin).toBe('commit')
    expect(reference('acme/plugin#main').pin).toBe('named')
    expect(reference('acme/plugin').pin).toBe('none')
  })

  test('reads the list shape people write', () => {
    const list = readPluginList([
      'acme/one#v1',
      { 'acme/two#v2': { registry: 'ghcr.io' } },
    ])

    expect(list).toEqual([
      { raw: 'acme/one#v1', parameters: {} },
      { raw: 'acme/two#v2', parameters: { registry: 'ghcr.io' } },
    ] as any)
  })

  test('refuses an entry that names two plugins at once', () => {
    expect(readPluginList([{ 'acme/one': {}, 'acme/two': {} }])).toEqual({ error: 'a plugin entry names exactly one plugin' })
  })
})

const MANIFEST = `
name: docker-login
description: Log in to a registry before the command
hooks: [environment, pre-command]
requires: [docker-socket]
parameters:
  registry:
    type: string
    required: true
  retries:
    type: number
    default: 3
  mode:
    type: string
    enum: [oidc, password]
  quiet: boolean
`

describe('a manifest', () => {
  test('declares its hooks, its capabilities, and its parameters', () => {
    const parsed = parseManifest(MANIFEST)

    expect('manifest' in parsed).toBe(true)

    const manifest = (parsed as any).manifest

    expect(manifest.hooks).toEqual(['environment', 'pre-command'])
    expect(manifest.requires).toEqual(['docker-socket'])
    expect(manifest.parameters.registry.required).toBe(true)
    expect(manifest.parameters.retries.default).toBe(3)
    // `quiet: boolean` rather than `quiet: { type: boolean }`, because that is
    // what people write first.
    expect(manifest.parameters.quiet.type).toBe('boolean')
  })

  test('refuses a hook stage this runner has no moment for', () => {
    const parsed = parseManifest('name: x\nhooks: [after-lunch]\n')

    expect((parsed as any).error).toContain('after-lunch')
  })

  test('refuses a capability this instance does not define', () => {
    const parsed = parseManifest('name: x\nrequires: [everything]\n')

    expect((parsed as any).error).toContain('everything')
  })
})

describe('parameters, checked before dispatch', () => {
  const manifest = (parseManifest(MANIFEST) as any).manifest

  test('fill in declared defaults', () => {
    const checked = validateParameters(manifest, { registry: 'ghcr.io' })

    expect(checked).toMatchObject({ ok: true, values: { registry: 'ghcr.io', retries: '3' } })
  })

  test('refuse a name the plugin does not have', () => {
    /*
     * The failure this catches is a typo, and a typo silently ignored is a
     * plugin running with its default while somebody reads the line they wrote
     * and believes it took effect.
     */
    const checked = validateParameters(manifest, { registry: 'ghcr.io', registery: 'ghcr.io' })

    expect(checked.ok).toBe(false)
    expect((checked as any).errors.join(' ')).toContain('registery')
  })

  test('refuse a missing required value, a wrong type, and a value outside the set', () => {
    expect(validateParameters(manifest, {}).ok).toBe(false)
    expect(validateParameters(manifest, { registry: 'ghcr.io', retries: 'three' }).ok).toBe(false)
    expect(validateParameters(manifest, { registry: 'ghcr.io', mode: 'sudo' }).ok).toBe(false)
  })

  test('become environment namespaced by plugin', () => {
    // Two plugins that both take a `registry` are ordinary, and one reading the
    // other's value is not a bug anybody would find quickly.
    expect(parameterEnvironment('docker-login', { registry: 'ghcr.io' })).toEqual({
      REVIEWOS_PLUGIN_DOCKER_LOGIN_REGISTRY: 'ghcr.io',
    })
  })
})

describe('the policy, at three levels', () => {
  test('narrows and never widens', () => {
    const combined = effectivePolicy([
      { allowlist: ['acme/one', 'acme/two'], requirePinned: false, capabilities: ['docker-socket', 'host-network'] },
      { allowlist: ['acme/two', 'acme/three'], requirePinned: true, capabilities: ['docker-socket'] },
    ])

    // The intersection, not the union: a level that could widen what the level
    // above allowed would make the level above decorative.
    expect(combined.allowlist).toEqual(['acme/two'])
    expect(combined.capabilities).toEqual(['docker-socket'])
    expect(combined.requirePinned).toBe(true)
  })

  test('reads an empty allowlist as no opinion and an empty capability set as none', () => {
    const combined = effectivePolicy([
      { allowlist: [], requirePinned: false, capabilities: [] },
      { allowlist: ['acme/one'], requirePinned: false, capabilities: [] },
    ])

    expect(combined.allowlist).toEqual(['acme/one'])
    // The other way round on purpose: a pool with no configuration should not
    // be handing out a docker socket.
    expect(combined.capabilities).toEqual([])
  })

  test('refuses a plugin off the allowlist', () => {
    const verdict = pluginVerdict({
      reference: reference('acme/four#v1'),
      policy: { allowlist: ['acme/one'], requirePinned: false, capabilities: [] },
    })

    expect(verdict.ok).toBe(false)
  })

  test('refuses a branch under a pinning policy and accepts a tag', () => {
    const policy = { allowlist: [], requirePinned: true, capabilities: [] }

    expect(pluginVerdict({ reference: reference('acme/one#main'), policy, resolvedRef: 'branch' }).ok).toBe(false)
    expect(pluginVerdict({ reference: reference('acme/one#v1'), policy, resolvedRef: 'tag' }).ok).toBe(true)
    expect(pluginVerdict({ reference: reference('acme/one'), policy, resolvedRef: null }).ok).toBe(false)

    // A vendored plugin is pinned however strict the policy is: it is the
    // commit the run is for.
    expect(pluginVerdict({ reference: reference('./.reviewos/plugins/p'), policy }).ok).toBe(true)
  })

  test('refuses a capability the pool does not grant, and names it', () => {
    const verdict = pluginVerdict({
      reference: reference('acme/one#v1'),
      policy: { allowlist: [], requirePinned: false, capabilities: ['host-network'] },
      requires: ['docker-socket'],
    })

    expect(verdict.ok).toBe(false)
    expect((verdict as any).reason).toContain('docker-socket')
  })
})
