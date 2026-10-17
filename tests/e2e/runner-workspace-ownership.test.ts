import { afterAll, beforeAll, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { LEASE_SECONDS, RUNNER_PROTOCOL } from '../../app/Actions/Runner/protocol'
import type { RunnerFacts } from '../../app/Actions/Runner/protocol'
import { reportJob } from '../../app/Actions/Runner/report'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'
import { serveForTest } from '../helpers/server'

const created = { ownerId: 0, repositoryId: 0, runners: [] as Array<{ id: number, token: string, facts: RunnerFacts }> }
let db: any
let server: any
let port = 0
const unique = () => `workspace${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`

beforeAll(async () => {
  const { injectGlobalAutoImports } = await import('@stacksjs/server')
  await injectGlobalAutoImports()
  db = (globalThis as any).db
  await db.selectFrom('workflow_job_claims').select(['id']).limit(1).execute()
  const handle = unique()
  const owner = await db.insertInto('users').values({ name: 'Workspace ownership', handle, email: `${handle}@example.com`, password: 'x' }).returning(['id']).executeTakeFirst()
  created.ownerId = Number(owner.id)
  const name = unique()
  const repository = await db.insertInto('repositories').values({ owner_type: 'user', owner_id: created.ownerId, name, visibility: 'private', default_branch: 'main', disk_path: `${handle}/${name}.git` }).returning(['id']).executeTakeFirst()
  created.repositoryId = Number(repository.id)
  for (let index = 0; index < 3; index++) {
    const token = crypto.randomUUID()
    const runner = await db.insertInto('runners').values({ name: unique(), scope_type: 'repository', scope_id: created.repositoryId, token_hash: hashToken(token), labels: 'ubuntu-latest', state: 'active' }).returning(['id']).executeTakeFirst()
    const id = Number(runner.id)
    created.runners.push({ id, token, facts: { id, state: 'active', scopeType: 'repository', scopeId: created.repositoryId, labels: ['ubuntu-latest'] } })
  }
  await syncWorkflowFile({ repositoryId: created.repositoryId, ownerType: 'user', ownerId: created.ownerId, path: '.github/workflows/ci.yml', sha: 'a'.repeat(40), source: 'name: Workspaces\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo complete\n' })
  ;({ server, port } = await serveForTest())
}, 120_000)

afterAll(async () => {
  server?.stop?.(true)
  if (!db) return
  if (created.repositoryId) {
    await db.deleteFrom('workflow_job_claims').where('repository_id', '=', created.repositoryId).execute()
    await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
  }
  for (const runner of created.runners) await db.deleteFrom('runners').where('id', '=', runner.id).execute()
  if (created.ownerId) await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
})

async function confirm(token: string | null, ids: unknown, protocol = String(RUNNER_PROTOCOL.current)) {
  return fetch(`http://127.0.0.1:${port}/api/runner/workspaces/retirable`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Runner-Protocol': protocol, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ job_ids: ids }) })
}

test('terminal ownership survives reassignment while running, foreign and unknown jobs stay protected', async () => {
  const first = created.runners[0]!
  const second = created.runners[1]!
  const stranger = created.runners[2]!
  await dispatchPush({ repositoryId: created.repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'b'.repeat(40) })
  const old = await claimNextJob(first.facts, new Date(Date.now() - (LEASE_SECONDS + 60) * 1000))
  expect(old).not.toBeNull()
  if (!old) throw new Error('The real first claim was not created')
  expect((await (await confirm(first.token, [old.jobId])).json()).retirable).toEqual([])
  const current = await claimNextJob(second.facts)
  expect(current?.jobId).toBe(old.jobId)
  expect((await (await confirm(first.token, [old.jobId])).json()).retirable).toEqual([])
  expect((await reportJob(second.facts, { jobId: old.jobId, state: 'succeeded' })).ok).toBe(true)
  const ownership = await db.selectFrom('workflow_job_claims').select(['runner_id']).where('workflow_job_id', '=', old.jobId).execute()
  expect(new Set(ownership.map((row: any) => Number(row.runner_id)))).toEqual(new Set([first.id, second.id]))
  expect((await (await confirm(first.token, [old.jobId, Number.MAX_SAFE_INTEGER])).json()).retirable).toEqual([old.jobId])
  expect((await (await confirm(second.token, [old.jobId])).json()).retirable).toEqual([old.jobId])
  expect((await (await confirm(stranger.token, [old.jobId])).json()).retirable).toEqual([])
})

test('workspace confirmation requires a runner credential, compatible protocol and bounded safe IDs', async () => {
  const runner = created.runners[0]!
  expect((await confirm(null, [1])).status).toBe(401)
  expect((await confirm(runner.token, [1], '999')).status).toBe(426)
  const identity = await confirm(runner.token, [])
  expect(identity.status).toBe(200)
  expect(await identity.json()).toEqual({ runner_id: runner.id, retirable: [] })
  for (const ids of [[true], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 101 }, (_, index) => index + 1)])
    expect((await confirm(runner.token, ids)).status).toBe(422)
})
