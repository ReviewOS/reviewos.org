import { expect, test } from 'bun:test'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'

test('repository workspace ownership and recovery use a fresh process', async () => {
  const result = await runIsolated(new URL('../fixtures/repository-workspace.fixture.ts', import.meta.url).pathname, {
    mode: 'test', envFile: false, preload: [], timeoutMs: 25000,
  })
  assertIsolatedOk(result)
  if (process.platform === 'linux') {
    expect(result.stderr).toContain('3 pass')
    expect(result.stdout).toMatch(/"recovery":"(?:retired-proven-unused|preserved-uninspectable)","owner":"dead"/)
  }
}, 30000)
