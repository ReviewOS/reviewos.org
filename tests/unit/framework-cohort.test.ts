import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const manifest = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'))

test('declared, overridden and installed framework packages share one published cohort', () => {
  // Separate router/database instances from mixed framework releases can
  // disagree even though dependency installation itself succeeds.
  const application = manifest('package.json')
  const version = application.dependencies.stacks
  const framework = manifest('node_modules/stacks/package.json')
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  expect(framework.version).toBe(version)
  const shared = new Set(Object.entries(framework.dependencies ?? {})
    .filter(([name, value]) => name.startsWith('@stacksjs/') && value === version).map(([name]) => name))
  expect(shared.has('@stacksjs/queue')).toBe(true)
  for (const section of ['dependencies', 'devDependencies', 'overrides']) {
    for (const [name, declared] of Object.entries(application[section] ?? {})) {
      if (!shared.has(name)) continue
      expect(declared, `${section}: ${name}`).toBe(version)
      expect(manifest(`node_modules/${name}/package.json`).version, `installed: ${name}`).toBe(version)
    }
  }
})
