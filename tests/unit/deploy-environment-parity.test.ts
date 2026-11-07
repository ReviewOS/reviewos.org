import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('both supported deployment paths preserve authentication, search and account synchronization', () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/deploy.yml']) {
    const source = readFileSync(file, 'utf8')
    for (const key of ['APP_KEY', 'DB_PASSWORD', 'GITHUB_SYNC_USER', 'GITHUB_SYNC_CREDENTIAL', 'MIRROR_TOKEN_GITHUB_ACCOUNT_FILE', 'TYPESENSE_API_KEY']) {
      expect(source).toContain(key + ': ${{')
      expect(source).toContain(`printf '${key}=%s\\n'`)
    }
  }
})
