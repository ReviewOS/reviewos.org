import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUNNER_PROTOCOL } from '../../app/Actions/Runner/protocol'
import { maintainRunnerWorkspaces } from '../../app/Actions/Runner/workspaceMaintenance'

test('maintenance verifies the registered identity without creating a missing journal or registering a runner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-maintenance-test-'))
  const requests: Array<{ path: string, body: unknown }> = []
  const token = crypto.randomUUID()
  let runnerId = 42
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, body: await request.json() })
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`)
    expect(request.headers.get('x-runner-protocol')).toBe(String(RUNNER_PROTOCOL.current))
    return Response.json({ runner_id: runnerId, retirable: [] })
  } })
  const journalRoot = join(root, 'missing')
  const options = { baseUrl: `http://127.0.0.1:${server.port}`, token, runnerId, journalRoot, apply: false }
  try {
    expect(await maintainRunnerWorkspaces(options)).toEqual({ retired: 0, ready: 0, preserved: 0 })
    expect(requests).toEqual([{ path: '/api/runner/workspaces/retirable', body: { job_ids: [] } }])
    expect(existsSync(journalRoot)).toBe(false)
    runnerId = 43
    await expect(maintainRunnerWorkspaces(options)).rejects.toThrow('ownership')
    expect(existsSync(journalRoot)).toBe(false)
    await expect(maintainRunnerWorkspaces({ ...options, runnerId: Number.NaN })).rejects.toThrow('--runner-id')
    expect(requests).toHaveLength(2)
  }
  finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})
