// A job's output: what a runner may write, and who may read it.
//
// The bytes come from a machine running hostile code, so the two things worth
// pinning are that there is a ceiling it cannot talk past, and that reading is
// the repository's permission rather than the runner's. Build output routinely
// carries paths, hostnames and the occasional thing somebody echoed by mistake.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendLog, MAX_JOB_LOG_BYTES, readLog } from '../../app/Actions/Runner/logs'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runnerIds: [] as number[] }

let available = false
let db: any = null
let server: any = null
let port = 0

const TOKEN = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: build
`

async function call(path: string, body: Record<string, unknown>, token: string) {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  return { status: r.status, body: await r.json().catch(() => ({})) as any }
}

/** Claim a job and keep the credential it was handed. */
async function claimOne(): Promise<{ id: number, token: string }> {
  await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: `${Math.random().toString(16).slice(2)}`.padEnd(40, '0'),
  })

  const answer = await call('/runner/claim', {}, TOKEN)
  return { id: Number(answer.body.job.id), token: String(answer.body.job.token) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()
    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.handle = unique('rlg')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Runner Logs', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    const runner: any = await db
      .insertInto('runners')
      .values({
        name: unique('runner'),
        scope_type: 'repository',
        scope_id: created.repositoryId,
        token_hash: hashToken(TOKEN),
        labels: 'ubuntu-latest',
        state: 'active',
      })
      .returning(['id'])
      .executeTakeFirst()
    created.runnerIds.push(Number(runner.id))

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'a'.repeat(40),
    })

    available = true
  }
  catch (error) {
    console.warn(`[runner-logs] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) } catch { /* already down */ }

  try {
    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('appending output', () => {
  test('stores a chunk and reads it back in order', async () => {
    if (!available)
      return

    const job = await claimOne()

    await call('/runner/logs', { sequence: 1, content: 'compiling\n' }, job.token)
    await call('/runner/logs', { sequence: 2, content: 'warning: unused\n', stream: 'stderr' }, job.token)

    const page = await readLog(job.id)

    expect(page.chunks.map(chunk => chunk.content)).toEqual(['compiling\n', 'warning: unused\n'])
    expect(page.chunks[1]?.stream).toBe('stderr')
    expect(page.cursor).toBe(2)
  })

  /*
   * At-least-once again: a runner that did not hear the answer sends the same
   * chunk, and without the sequence the log grows a second copy of whatever the
   * network dropped an acknowledgement for.
   */
  test('the same chunk twice is stored once', async () => {
    if (!available)
      return

    const job = await claimOne()

    const first = await call('/runner/logs', { sequence: 1, content: 'once\n' }, job.token)
    const second = await call('/runner/logs', { sequence: 1, content: 'once\n' }, job.token)

    expect(first.body.duplicate).toBe(false)
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)

    expect((await readLog(job.id)).chunks.length).toBe(1)
  })

  test('a credential for another job cannot write here', async () => {
    if (!available)
      return

    const mine = await claimOne()
    const other = await claimOne()

    await call('/runner/logs', { sequence: 1, content: 'from the other job\n' }, other.token)

    // It wrote to its own log, not to this one.
    expect((await readLog(mine.id)).chunks.length).toBe(0)
    expect((await readLog(other.id)).chunks.length).toBe(1)
  })

  test('and no credential writes nothing', async () => {
    if (!available)
      return

    const job = await claimOne()
    const answer = await call('/runner/logs', { sequence: 1, content: 'x' }, 'job-not-real')

    expect(answer.status).toBe(401)
    expect((await readLog(job.id)).chunks.length).toBe(0)
  })

  test('a sequence below one is refused rather than stored', async () => {
    if (!available)
      return

    const job = await claimOne()
    const answer = await call('/runner/logs', { sequence: 0, content: 'x' }, job.token)

    expect(answer.status).toBe(422)
  })
})

describe('the ceiling', () => {
  /*
   * A runner streaming forever is not stopped by a retention policy that runs
   * tomorrow: it fills the disk tonight. The ceiling is enforced on the way in.
   */
  test('a job cannot write past it, and is told so', async () => {
    if (!available)
      return

    const job = await claimOne()
    const block = 'x'.repeat(60_000)

    let truncated = false
    let sequence = 1

    // Comfortably past the ceiling, in chunks a real runner might send.
    while (sequence <= Math.ceil(MAX_JOB_LOG_BYTES / 60_000) + 2) {
      const outcome = await appendLog({ jobId: job.id, sequence, content: block })
      truncated ||= outcome.truncated
      sequence++
    }

    expect(truncated).toBe(true)

    const stored: any[] = await db
      .selectFrom('workflow_job_logs')
      .select(['content'])
      .where('workflow_job_id', '=', job.id)
      .execute()

    const bytes = stored.reduce((total, row) => total + new TextEncoder().encode(String(row.content)).length, 0)

    // Within one chunk's worth of the ceiling, and nowhere near unbounded.
    expect(bytes).toBeLessThan(MAX_JOB_LOG_BYTES + 70_000)
  }, 60_000)

  // Accepted and dropped rather than refused: a 4xx here makes a correct runner
  // retry a chunk that will never be wanted.
  test('an append past the ceiling still answers ok', async () => {
    if (!available)
      return

    const job = await claimOne()
    await appendLog({ jobId: job.id, sequence: 1, content: 'x'.repeat(60_000) })

    const outcome = await appendLog({ jobId: job.id, sequence: 2, content: 'more' })

    expect(outcome.ok).toBe(true)
  })
})

describe('reading', () => {
  test('a cursor returns only what is new', async () => {
    if (!available)
      return

    const job = await claimOne()
    await call('/runner/logs', { sequence: 1, content: 'one\n' }, job.token)
    await call('/runner/logs', { sequence: 2, content: 'two\n' }, job.token)

    const page = await readLog(job.id, 1)

    expect(page.chunks.map(chunk => chunk.content)).toEqual(['two\n'])
    expect(page.cursor).toBe(2)
  })

  test('and an unchanged cursor when there is nothing new', async () => {
    if (!available)
      return

    const job = await claimOne()
    await call('/runner/logs', { sequence: 1, content: 'one\n' }, job.token)

    const page = await readLog(job.id, 1)

    expect(page.chunks).toEqual([])
    expect(page.cursor).toBe(1)
  })

  /*
   * The job id is a number anybody can increment. Without the repository check
   * it is a way to read another repository's build output.
   */
  test('the endpoint refuses a job that is not this repository\'s', async () => {
    if (!available)
      return

    const r = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/log`
      + `?owner=${created.handle}&repo=${created.name}&job=999999999`,
    )

    expect(r.status).toBe(404)
  })
})


describe('output sent as events', () => {
  const ESC = String.fromCharCode(27)

  /*
   * The plain-text form is not deprecated and this is the proof: a runner that
   * sends bytes is doing the honest thing, and requiring structure to say "here
   * is a line" would be a protocol nobody could write in an afternoon. Events
   * are for the four things text cannot carry.
   */
  test('are stored beside the text a plain reader gets', async () => {
    if (!available)
      return

    const job = await claimOne()

    const answer = await call('/runner/logs', {
      sequence: 1,
      events: [
        { type: 'group', text: 'Install' },
        { type: 'line', text: `${ESC}[32mok${ESC}[0m`, at: '2026-08-13T10:00:00.000Z' },
        { type: 'endgroup' },
      ],
    }, job.token)

    expect(answer.status).toBe(200)
    // How many were understood, so a runner ahead of this server can see that
    // some were dropped rather than assuming they landed.
    expect(answer.body.events).toBe(3)

    const page = await readLog(job.id)

    // The text is what a plain reader would have seen, derived rather than sent
    // twice: a runner should not have to keep two forms in step.
    expect(page.chunks[0]?.content).toBe(`Install\n${ESC}[32mok${ESC}[0m\n`)
    expect(page.chunks[0]?.events?.length).toBe(3)
  })

  test('a runner sending an event type this server has not learned keeps the rest', async () => {
    if (!available)
      return

    const job = await claimOne()

    const answer = await call('/runner/logs', {
      sequence: 1,
      events: [
        { type: 'line', text: 'before' },
        { type: 'annotation', text: 'from a newer runner' },
        { type: 'line', text: 'after' },
      ],
    }, job.token)

    // Two of the three: the unknown one is dropped rather than costing the
    // lines around it, which are what somebody is waiting to read.
    expect(answer.body.events).toBe(2)
    expect((await readLog(job.id)).chunks[0]?.content).toBe('before\nafter\n')
  })

  test('and text still works, with no events stored beside it', async () => {
    if (!available)
      return

    const job = await claimOne()
    await call('/runner/logs', { sequence: 1, content: 'plain output\n' }, job.token)

    const page = await readLog(job.id)

    expect(page.chunks[0]?.content).toBe('plain output\n')
    expect(page.chunks[0]?.events).toBeUndefined()
  })
})

describe('a job producing faster than the instance wants to store', () => {
  test('is asked to slow down rather than having the middle of its log dropped', async () => {
    if (!available)
      return

    /*
     * The per-job ceiling truncates at the *end*, visibly, and that is
     * survivable. Dropping the middle is not: a log missing the part where
     * something went wrong is worse than one that stops, because a reader
     * cannot tell it happened.
     *
     * So a chunk over the instance's budget is refused with a wait and sent
     * again. It is idempotent on its sequence, so the retry costs nothing and
     * the log stays whole and in order.
     */
    const { appendLog } = await import('../../app/Actions/Runner/logs')
    const { writeSetting } = await import('../../app/Ops/settings')

    const job = (await claimOne()).id

    // A budget small enough to cross in two chunks. The default is eight
    // megabytes a second, which is a property of the disk rather than of this
    // test.
    await writeSetting('log_bytes_per_second', '2048', null)

    try {
      const chunk = 'x'.repeat(1500)

      const first = await appendLog({ jobId: job, sequence: 1, content: chunk, stream: 'stdout' })
      const second = await appendLog({ jobId: job, sequence: 2, content: chunk, stream: 'stdout' })

      expect(first.ok).toBe(true)

      expect(second.ok).toBe(false)
      expect(Number(second.retryAfterMs)).toBeGreaterThan(0)
      expect(Number(second.retryAfterMs)).toBeLessThanOrEqual(1000)

      // Nothing was lost: the refused chunk was never stored, so the runner
      // sending it again lands it in order rather than after a hole.
      const stored: any[] = await db
        .selectFrom('workflow_job_logs')
        .select(['sequence'])
        .where('workflow_job_id', '=', job)
        .orderBy('sequence')
        .execute()

      expect(stored.map(row => Number(row.sequence))).toEqual([1])
    }
    finally {
      // Off again, so the rest of this suite is not throttled by a setting this
      // test left behind.
      await writeSetting('log_bytes_per_second', '0', null)
    }
  })
})
