import { test } from 'bun:test'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'

test('repository workspace ownership and recovery use a fresh process', async () => {
  const result = await runIsolated(new URL('../fixtures/repository-workspace.test.ts', import.meta.url).pathname, {
    mode: 'test', envFile: false, preload: [], timeoutMs: 25000,
  })
  assertIsolatedOk(result)
}, 30000)
