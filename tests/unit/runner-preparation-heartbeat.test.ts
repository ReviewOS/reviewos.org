// A checkout can outlast the lease too. Exercise the runner's HTTP protocol
// while its real checkout hook waits, before any workflow step can begin.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

let server: ReturnType<typeof Bun.serve>
let root = ''
let next: Record<string, unknown> | null = null
const beats: Array<{ preparing: boolean, authorization: string | null, steps: any[] | null }> = []
const reports: any[] = []
const afterConclusion: unknown[] = []

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-preparation-lease-'))
  const hooks = join(root, 'hooks')
  mkdirSync(hooks)
  writeFileSync(join(hooks, 'checkout'), `#!/bin/sh
touch checkout-active
sleep 25
test -f continue-checkout || exit 25
touch checkout-complete
`, { mode: 0o755 })
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.json()
      if (path === '/api/runner/claim') {
        const job = next
        next = null
        return Response.json(job ? { job } : {})
      }
      if (path === '/api/runner/heartbeat') {
        const workspace = join(root, 'job-9103')
        const preparing = existsSync(join(workspace, 'checkout-active')) && !existsSync(join(workspace, 'checkout-complete'))
        beats.push({ preparing, authorization: request.headers.get('authorization'), steps: body.steps })
        if (reports.length)
          afterConclusion.push(body)
        if (preparing)
          writeFileSync(join(workspace, 'continue-checkout'), '')
      }
      if (path === '/api/runner/report')
        reports.push(body)
      return Response.json({ ok: true, held: true })
    },
  })
})

afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

test('renews the lease during checkout, then reports the workflow step normally', async () => {
  next = {
    id: 9103,
    token: 'job-preparation-token',
    key: 'preparation',
    repository_full_name: 'acme/widgets',
    run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
    steps: [{ name: 'Use the checkout', run: 'test -f checkout-complete' }],
  }
  const outcome = await runOnce({
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: 'runner',
    workspaceRoot: root,
    hooksDirectory: join(root, 'hooks'),
    tools: false,
  })
  expect(outcome).toEqual(expect.objectContaining({ state: 'succeeded' }))
  expect(beats.some(beat => beat.preparing && beat.steps === null)).toBe(true)
  expect(beats.every(beat => beat.authorization === 'Bearer job-preparation-token')).toBe(true)
  expect(reports).toHaveLength(1)
  expect(reports[0].state).toBe('succeeded')
  const steps = [...beats.flatMap(beat => beat.steps ?? []), ...(reports[0].steps ?? [])]
  expect(steps).toContainEqual(expect.objectContaining({ position: 0, exit_code: 0 }))
  expect(afterConclusion).toEqual([])
}, 45_000)
