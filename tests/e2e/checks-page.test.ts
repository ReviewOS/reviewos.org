// What a reviewer sees about CI, from a report over the API to a page.
//
// Two claims, and they are the same claim from two sides. The checks tab tells
// somebody *which* check said what, how long it took and whether it was even
// looking at this commit - a rollup dot answers none of that, and the reason
// people click through to a CI provider is that the forge told them "failing"
// and nothing else.
//
// And an annotation goes on the line it is about. A tool that reports "unused
// variable, app.ts line 3" and is rendered as a link to a log has been turned
// back into a log, which is where nobody reads it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  headSha: '',
  baseSha: '',
}

let available = false
let db: any = null
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return stdout.trim()
}

async function tab(name: string): Promise<string> {
  const answer = await fetch(
    `http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1?tab=${name}`,
    { headers: { Accept: 'text/html' } },
  )

  return await answer.text()
}

/** Markup with its tags removed: highlighted code is not contiguous text. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
}

async function reportRun(row: Record<string, unknown>): Promise<number> {
  const inserted: any = await db.insertInto('check_runs').values({
    repository_id: created.repositoryId,
    head_sha: created.headSha,
    name: 'ci/build',
    status: 'completed',
    conclusion: 'success',
    attempt: 1,
    provider: 'e2e',
    ...row,
  }).returning(['id']).executeTakeFirst()

  return Number(inserted?.id)
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-checks-page-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('chk')
    const user: any = await db.insertInto('users')
      .values({ name: 'Checks Reader', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(user?.id)
    created.name = unique('repo')

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: resolved.relative!,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'seed')
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'app.ts'), 'export const keep = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    created.baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'app.ts'), 'export const keep = 1\nexport const second = 2\nexport const third = 3\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the change')
    created.headSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    await db.insertInto('pull_requests').values({
      repository_id: created.repositoryId,
      number: 1,
      title: 'Checks fixture',
      body: '',
      author_id: created.ownerId,
      state: 'open',
      head_branch: 'change',
      head_sha: created.headSha,
      base_branch: 'main',
      base_sha: created.baseSha,
      draft: false,
      additions: 2,
      deletions: 0,
      changed_files: 1,
    }).execute()

    /*
     * A branch rule naming two checks.
     *
     * `security/scan` is the interesting one: it is required, and it reported
     * on the *previous* head. Without a rule naming it, a check that did not
     * report on this commit is not surfaced at all - which is right, because
     * every check name that has ever existed is "not reported on this commit"
     * and listing them would bury the six that matter.
     */
    await db.insertInto('protected_branches').values({
      repository_id: created.repositoryId,
      pattern: 'main',
      required_approvals: 0,
      required_checks: JSON.stringify(['security/scan', 'ci/build']),
    }).execute()

    // A believable spread: one that passed, one still going, one cancelled
    // because a newer push arrived, one that reported on the previous head, and
    // one posting through the older status API.
    await reportRun({
      name: 'ci/build',
      started_at: new Date(Date.now() - 95_000).toISOString(),
      completed_at: new Date().toISOString(),
    })

    await reportRun({ name: 'ci/e2e', status: 'in_progress', conclusion: null })
    await reportRun({ name: 'ci/lint', conclusion: 'cancelled' })
    await reportRun({ name: 'security/scan', head_sha: created.baseSha, attempt: 4 })

    await db.insertInto('commit_statuses').values({
      repository_id: created.repositoryId,
      sha: created.headSha,
      context: 'legacy/status',
      state: 'success',
      description: 'posted through the older API',
    }).execute()

    const annotated = await reportRun({ name: 'ci/types', conclusion: 'failure' })

    await db.insertInto('check_annotations').values({
      check_run_id: annotated,
      path: 'app.ts',
      start_line: 3,
      end_line: 3,
      side: 'right',
      level: 'failure',
      title: 'Unused export',
      message: 'third is never read outside this file',
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[checks-page] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }

  try { rmSync(created.temp, { recursive: true, force: true }) }
  catch { /* a temp directory */ }

  try { rmSync(created.diskPath, { recursive: true, force: true }) }
  catch { /* a bare repository under storage */ }
})

describe('the checks tab', () => {
  test('names every check and what each one said', async () => {
    if (!available)
      return

    const words = text(await tab('checks'))

    expect(words).toContain('ci/build')
    expect(words).toContain('Passed')
    expect(words).toContain('ci/e2e')
    expect(words).toContain('Running')
    expect(words).toContain('ci/types')
    expect(words).toContain('Failed')
    // The older reporting API is a first-class citizen, not a footnote.
    expect(words).toContain('legacy/status')
  })

  /*
   * The distinction the rollup deliberately does not make. Both block a merge;
   * telling somebody their check "failed" when a newer push cancelled it sends
   * them to read a log that says nothing.
   */
  test('says cancelled rather than failed', async () => {
    if (!available)
      return

    const words = text(await tab('checks'))

    expect(words).toContain('ci/lint')
    expect(words).toContain('Cancelled')
  })

  test('reports how long a check took', async () => {
    if (!available)
      return

    // Roughly a minute and a half, in the units somebody waits in.
    expect(text(await tab('checks'))).toContain('1m 35s')
  })

  /*
   * The green tick that is about code nobody is merging. Every forge shows one
   * somewhere; this one says which commit it belongs to.
   */
  test('and marks a report that was about an earlier commit', async () => {
    if (!available)
      return

    const words = text(await tab('checks'))

    expect(words).toContain('security/scan')
    expect(words).toContain('on an earlier commit')
    expect(words).toContain(created.baseSha.slice(0, 10))
  })

  test('and says which of them a branch rule requires', async () => {
    if (!available)
      return

    const words = text(await tab('checks'))

    expect(words).toContain('Required')
  })

  test('the rollup is a sentence, and a failure is not hidden behind a count', async () => {
    if (!available)
      return

    const words = text(await tab('checks'))

    expect(words).toMatch(/\d+ of \d+ failed/)
  })
})

describe('annotations in the diff', () => {
  test('render on the line the check named', async () => {
    if (!available)
      return

    const html = await tab('files')
    const words = text(html)

    expect(words).toContain('Unused export')
    expect(words).toContain('third is never read outside this file')
    // As an error rather than a note: the reporter said `failure`.
    expect(html).toContain('annotation-bad')
  })

  test('and the checks tab links to them rather than describing them twice', async () => {
    if (!available)
      return

    expect(text(await tab('checks'))).toContain('1 annotation in the diff')
  })
})
