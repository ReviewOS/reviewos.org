import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'
import { workspaceJournal } from '../../app/Actions/Runner/workspaceJournal'

test('a completed live job disposes its own ephemeral workspace without requiring global process inspection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-live-workspace-'))
  const logs: string[] = []
  const jobId = 643
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname
    const body = await request.json() as Record<string, unknown>
    if (path === '/api/runner/claim') {
      return Response.json({ runner_id: 42, job: {
        id: jobId, token: crypto.randomUUID(), key: 'live-workspace', tracking_id: crypto.randomUUID(), checkout: { skip: true },
        steps: [{ name: 'workspace', run: 'pwd' }],
        run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'a'.repeat(40), trusted: true },
        repository_full_name: 'fixture/workspace',
      } })
    }
    if (path === '/api/runner/logs') logs.push(String(body.content ?? ''))
    return Response.json({ ok: true, held: true })
  } })
  const options = { baseUrl: `http://127.0.0.1:${server.port}`, token: crypto.randomUUID(), workspaceJournalRoot: join(root, 'journals'), tools: false }
  let workspace: string | undefined
  try {
    const outcome = await runOnce(options)
    expect(outcome?.state).toBe('succeeded')
    workspace = logs.join('').split('\n').find(line => line.startsWith(join(realpathSync(tmpdir()), `reviewos-job-${jobId}-`)))
    expect(workspace).toBeDefined()
    if (!workspace) throw new Error('The real step did not report its workspace')
    expect(existsSync(workspace)).toBe(false)
    expect(workspaceJournal({ ...options, runnerId: 42 })?.list()).toEqual([])
  }
  finally {
    server.stop(true)
    if (workspace) rmSync(workspace, { recursive: true, force: true })
    for (const record of workspaceJournal({ ...options, runnerId: 42 }, true)?.list() ?? [])
      rmSync(record.path, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
