// Variables at three levels, and the question the feature exists to answer.
//
// Three places can set `REGISTRY`: the instance, the owner, and the
// repository. A workflow file's `env:` is not a fourth - it feeds `env`, never
// `vars` (#30). The precedence itself is the boring part - narrowest wins,
// which is what everybody expects. What people cannot do elsewhere is find out
// *which* level answered, and a value that is wrong at a level nobody is
// looking at is an afternoon.

import { describe, expect, test } from 'bun:test'
import { PRECEDENCE, resolveVariables } from '../../app/Actions/Workflow/variables'

const AT_EVERY_LEVEL = [
  { key: 'REGISTRY', value: 'docker.io', scope: 'instance' as const, from: 'this instance' },
  { key: 'REGISTRY', value: 'ghcr.io/acme', scope: 'owner' as const, from: 'acme' },
  { key: 'REGISTRY', value: 'ghcr.io/acme/widgets', scope: 'repository' as const, from: 'widgets' },
]

describe('precedence', () => {
  test('narrowest wins, and the order is written down rather than implied', () => {
    expect(Object.keys(PRECEDENCE).sort()).toEqual(['instance', 'owner', 'repository'])
    expect(PRECEDENCE.repository).toBeGreaterThan(PRECEDENCE.owner)
    expect(PRECEDENCE.owner).toBeGreaterThan(PRECEDENCE.instance)
  })

  test('the repository beats everything', () => {
    const [registry] = resolveVariables(AT_EVERY_LEVEL)

    expect(registry!.value).toBe('ghcr.io/acme/widgets')
    expect(registry!.scope).toBe('repository')
  })

  test('and the answer carries what it beat, widest last', () => {
    /*
     * The sentence that ends the argument about why a deploy went to the wrong
     * region. "It is ghcr.io/acme/widgets" is not enough; "and the owner's
     * ghcr.io/acme is underneath it" is.
     */
    const [registry] = resolveVariables(AT_EVERY_LEVEL)

    expect(registry!.shadowed.map(one => one.scope)).toEqual(['owner', 'instance'])
    expect(registry!.shadowed[0]!.value).toBe('ghcr.io/acme')
  })

  test('the input order does not decide the answer', () => {
    // A resolution that depended on the order rows came back in would be a
    // resolution that changes when somebody adds an index.
    const forwards = resolveVariables(AT_EVERY_LEVEL)
    const backwards = resolveVariables([...AT_EVERY_LEVEL].reverse())

    expect(backwards).toEqual(forwards)
  })

  test('a key set at one level only is that level, with nothing shadowed', () => {
    const resolved = resolveVariables([{ key: 'ONLY', value: 'x', scope: 'owner', from: 'acme' }])

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.shadowed).toEqual([])
  })

  test('different keys do not interfere, and the list is sorted for a reader', () => {
    const resolved = resolveVariables([
      { key: 'ZONE', value: 'b', scope: 'repository', from: 'widgets' },
      { key: 'ALPHA', value: 'a', scope: 'instance', from: 'this instance' },
    ])

    // Sorted by name, because this is read as a list by a person far more often
    // than by a program, and one that reorders between loads cannot be scanned.
    expect(resolved.map(one => one.key)).toEqual(['ALPHA', 'ZONE'])
  })

  test('an empty name is not a variable', () => {
    expect(resolveVariables([{ key: '  ', value: 'x', scope: 'instance', from: 'this instance' }])).toEqual([])
  })
})
