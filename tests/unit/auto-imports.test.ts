// The auto-import barrel, and the collision that had disabled all of it.
//
// `storage/framework/auto-imports/functions.ts` re-exports every function in
// `resources/functions/`. One namespace, so two modules exporting one name make
// the file fail to compile - and the loader reports that as a warning and
// carries on, which means every function in the product silently stops being
// auto-imported at once. Views here import explicitly, so the product kept
// working and nothing pointed at the cause.
//
// Nine names collided: `relativeTime`, `tokensFor`, `buildStack`,
// `orphanReason`, `orphanMessage`, `blockedBy`, `stackSummary`,
// `labelTextColor`, `highlightLines`, `languageFor`. Most were convenience
// re-exports so one view could have one import line.

import { describe, expect, test } from 'bun:test'

const BARREL = 'storage/framework/auto-imports/functions.ts'

interface Export {
  name: string
  module: string
}

/** Every `export { … } from '…'` line, flattened. */
function exportsOf(source: string): Export[] {
  const found: Export[] = []

  for (const line of source.split('\n')) {
    const match = /^export (?:type )?\{([^}]*)\} from '([^']+)'/.exec(line.trim())

    if (!match)
      continue

    const [, names = '', module = ''] = match

    for (const name of names.split(',')) {
      const trimmed = name.trim()

      if (trimmed)
        found.push({ name: trimmed, module: module.split('/').at(-1) ?? module })
    }
  }

  return found
}

describe('the barrel', () => {
  test('exports every name once', async () => {
    const seen = new Map<string, string[]>()

    for (const { name, module } of exportsOf(await Bun.file(BARREL).text()))
      seen.set(name, [...(seen.get(name) ?? []), module])

    // Reported with the modules rather than as a count: the fix is deciding
    // which module owns the name, and that needs to know who claims it.
    const collisions = [...seen.entries()]
      .filter(([, modules]) => modules.length > 1)
      .map(([name, modules]) => `${name}: ${modules.join(', ')}`)

    expect(collisions).toEqual([])
  })

  test('and compiles, which is the thing a duplicate name prevents', async () => {
    /*
     * Transpiled rather than imported. Importing it *runs* every module it
     * re-exports, and some of those are browser modules calling composables
     * (`useDark()`) that only exist once the loader has injected them - so a
     * plain import fails for a reason that has nothing to do with this check.
     * The transpiler answers the only question here: does the file compile.
     */
    const source = await Bun.file(BARREL).text()
    const transpiler = new Bun.Transpiler({ loader: 'ts' })

    expect(() => transpiler.transformSync(source)).not.toThrow()

    // And the names are really there, since a barrel that compiles to nothing
    // would also pass the line above.
    expect(transpiler.scan(source).exports.length).toBeGreaterThan(100)
  })
})
