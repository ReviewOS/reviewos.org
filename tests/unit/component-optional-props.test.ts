import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * An optional prop is read through `typeof` before it is named.
 *
 * A component asked for without one of its optional props does not receive an
 * `undefined`. Under `route.serve()` it receives nothing at all, and naming an
 * identifier that was never declared throws where it is named - `??` and `?.`
 * are both too late, because the throw happens before either is reached.
 *
 * stx catches that throw and renders the component with every variable
 * undefined, which in practice means the component renders as nothing. So one
 * missing attribute does not default one value: it empties the component, and
 * says so only in the server log.
 *
 * It survives the plugin pipeline, which declares absent props as undefined,
 * and that is what makes it worth a test: the failure appears in the e2e suite
 * and never in a browser, so it reads as a broken test rather than a bug.
 *
 * `typeof x === 'undefined' ? fallback : …` is the shape that works.
 */

const COMPONENTS = resolve(import.meta.dir, '../../resources/components')

/** Identifiers every script has, which are not props. */
const AMBIENT = new Set([
  'params', 'headers', 'request', 'response', 'props', 'db', 'process',
  '__stxServeContext', 'setResponseStatus', 'globalThis', 'console',
])

function unguardedPropsIn(source: string): string[] {
  const script = source.match(/<script server>([\s\S]*?)<\/script>/)?.[1]

  if (!script)
    return []

  let code = script.replace(/\/\*[\s\S]*?\*\//g, '')
  code = code.replace(/\/\/.*/g, '')

  const declared = new Set<string>()
  for (const m of code.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g))
    declared.add(m[1]!)
  for (const m of code.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const name of m[1]!.split(','))
      declared.add(name.trim().split(/\s+as\s+/).pop()!.trim())
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g))
    declared.add(m[1]!)
  // Arrow and function parameters are declared where they are written.
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const name of m[1]!.split(','))
      declared.add(name.trim())
  }

  const guarded = new Set([...code.matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*[=!]==/g)].map(m => m[1]!))

  const unguarded = new Set<string>()

  // A bare identifier followed by `??` or `?.` — not a property access.
  for (const m of code.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*(?:\?\?|\?\.)/g)) {
    const name = m[1]!

    if (declared.has(name) || guarded.has(name) || AMBIENT.has(name))
      continue

    unguarded.add(name)
  }

  return [...unguarded]
}

describe('component optional props', () => {
  it('are all guarded with typeof before they are named', () => {
    const offenders: string[] = []

    for (const entry of readdirSync(COMPONENTS)) {
      if (!entry.endsWith('.stx'))
        continue

      const found = unguardedPropsIn(readFileSync(join(COMPONENTS, entry), 'utf8'))

      if (found.length)
        offenders.push(`${entry}: ${found.join(', ')}`)
    }

    expect(offenders).toEqual([])
  })
})
