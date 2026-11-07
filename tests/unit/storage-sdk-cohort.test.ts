import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const manifest = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'))

test('the installed storage SDK matches its declaration and override', () => {
  // Bun honors overrides before dependencies. A partial bump otherwise installs
  // an older SDK successfully, even with an exact dependency declaration.
  const application = manifest('package.json')
  const declared = application.dependencies['@stacksjs/ts-cloud']
  expect(declared).toMatch(/^\d+\.\d+\.\d+$/)
  expect(application.overrides['@stacksjs/ts-cloud']).toBe(declared)
  expect(manifest('node_modules/@stacksjs/ts-cloud/package.json').version).toBe(declared)
  expect(manifest('node_modules/@ts-cloud/core/package.json').version).toBe(declared)
})
