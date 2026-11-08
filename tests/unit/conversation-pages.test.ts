import { test } from 'bun:test'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import { withDisposableDatabase, disposablePostgresUrl } from '@stacksjs/testing/disposable-database'

const postgres = disposablePostgresUrl()
for (const dialect of ['sqlite', 'postgres']) {
  test.skipIf(dialect === 'postgres' && !postgres)(`${dialect} bounded discussion pages`, async () => {
    await withDisposableDatabase(dialect as 'sqlite' | 'postgres', async database => {
    assertIsolatedOk(await runIsolated(new URL('../fixtures/conversation-pages.fixture.ts', import.meta.url).pathname, {
      mode: 'test', envFile: false, preload: [], timeoutMs: 35000,
      env: { ...database.env, CONVERSATION_TEST_DIALECT: dialect },
    }))
    }, { ...(postgres ? { url: postgres } : {}), prefix: 'reviewos_discussion' })
  }, 40000)
}
