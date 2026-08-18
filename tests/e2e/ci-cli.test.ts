// The pipeline surface from a terminal.
//
// The property worth testing is not that the commands print something - it is
// that they are **clients of the public API and nothing else**. A command that
// reached the database would work on the instance's own machine and nowhere
// else, and would stop being a test of whether the API is usable by anybody.
//
// So this runs the real binary against a served instance, with a token, the way
// an operator would.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', token: '', runNumber: 0, jobKey: 'build' }

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Run `buddy ci:...` the way a person would, and collect what it printed. */
async function cli(...args: string[]): Promise<{ code: number, out: string, err: string }> {
  const child = Bun.spawn(['./buddy', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      REVIEWOS_URL: `http://127.0.0.1:${port}`,
      REVIEWOS_TOKEN: created.token,
      REVIEWOS_REPOSITORY: `${created.handle}/${created.name}`,
    },
  })

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { code, out, err }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('cli')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'CLI', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.github/workflows/ci.yml',
      name: 'CI',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: Number(workflow.id),
      source_sha: 'a'.repeat(40),
      source_path: '.github/workflows/ci.yml',
      content_digest: unique('d').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    const run: any = await db.insertInto('workflow_runs').values({
      workflow_version_id: Number(version.id),
      repository_id: created.repositoryId,
      number: 7,
      state: 'failed',
      event: 'push',
      event_ref: 'refs/heads/main',
      head_sha: 'b'.repeat(40),
      definition_sha: 'b'.repeat(40),
      trusted: true,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }).returning(['id']).executeTakeFirst()

    created.runNumber = 7

    const job: any = await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: created.jobKey,
      name: 'Build',
      position: 0,
      state: 'failed',
      runs_on: 'ubuntu-latest',
      finished_at: new Date().toISOString(),
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('workflow_job_logs').values({
      workflow_job_id: Number(job.id),
      attempt: 1,
      sequence: 1,
      stream: 'stdout',
      content: 'error TS2345: not assignable\n',
    }).execute()

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()

    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'cli test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    for (const [scope, level] of [['checks', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[ci-cli] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try {
    server?.stop?.()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('reading', () => {
  test('lists the runs, and shows one with its jobs', async () => {
    if (!available)
      return

    const runs = await cli('ci:runs')

    expect(runs.code).toBe(0)
    expect(runs.out).toContain('#7')
    expect(runs.out).toContain('failed')

    const one = await cli('ci:run', '7')

    expect(one.out).toContain('Build')
    expect(one.out).toContain('failed')
  }, 180_000)

  test('prints a job\'s output by name, with nothing added', async () => {
    if (!available)
      return

    /*
     * Straight to stdout, so `| grep` behaves and a redirect is the log rather
     * than a transcript of this program - and by *name*, because a person has a
     * job name and the endpoint wants an id.
     */
    const logs = await cli('ci:logs', '7', 'build')

    expect(logs.code).toBe(0)
    expect(logs.out).toBe('error TS2345: not assignable\n')
  }, 180_000)

  test('and a job name nobody has says which names there are', async () => {
    if (!available)
      return

    // The usual cause is a job id that reads differently from the name on the
    // screen, so listing them is the answer rather than "not found".
    const missing = await cli('ci:logs', '7', 'ghost')

    expect(missing.code).toBe(1)
    expect(missing.err).toContain('build')
  }, 180_000)
})

describe('changing something', () => {
  test('re-runs a finished run and reports the attempt', async () => {
    if (!available)
      return

    const rerun = await cli('ci:rerun', '7', '--scope', 'all')

    expect(rerun.code).toBe(0)
    expect(rerun.out).toContain('attempt 2')
  }, 180_000)

  test('and cancels one job of it', async () => {
    if (!available)
      return

    const cancelled = await cli('ci:cancel', '7', '--job', created.jobKey)

    expect(cancelled.code).toBe(0)
    expect(cancelled.out).toContain(created.jobKey)
  }, 180_000)
})

describe('when something is wrong', () => {
  test('a refused credential says so rather than printing a body', async () => {
    if (!available)
      return

    /*
     * A CLI that prints `{"error":"Unauthorized"}` and exits 1 has told
     * somebody nothing: they cannot tell a wrong token from a wrong repository
     * from an instance that is not running.
     */
    const refused = await cli('ci:runs', '--token', 'ros_not-a-real-token')

    expect(refused.code).toBe(1)
    expect(refused.err).toContain('REVIEWOS_TOKEN')
  }, 180_000)

  test('and validating a workflow needs no instance at all', async () => {
    if (!available)
      return

    // Parsing is this repository's own code, and asking somebody to push a
    // broken file to find out it is broken is the loop this removes.
    const validated = await cli('ci:validate', '.github/workflows/ci.yml')

    expect(validated.code).toBe(0)
    expect(validated.out).toContain('jobs, no problems')
  }, 180_000)
})
