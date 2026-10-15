// The workflow's and the job's `env:`, in every step's environment.
//
// Neither level ever reached a step: the claim carried only each step's own
// `env:`, so a workflow with `env: { BUN_VERSION: 1.4.2 }` at the top saw an
// empty `$BUN_VERSION` in every step - found on stacksjs/hq.training's runner,
// whose first step compares the two. The claim now sends both levels merged
// (`job.env`, the job's winning) and the runner resolves them once and puts
// them under each step's own.
//
// Run through `runOnce` against a stub control plane, so what is asserted is
// what a step's shell actually sees.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'
import { resolveEnv } from '../../app/Actions/Workflow/env'

let server: ReturnType<typeof Bun.serve>
let workspaceRoot = ''
let next: any = null

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'reviewos-jobenv-'))

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      await request.json().catch(() => ({}))

      if (path === '/api/runner/claim') {
        const job = next
        next = null

        return Response.json(job ? { job } : {})
      }

      return Response.json({ ok: true, held: true })
    },
  })
})

afterAll(() => {
  server.stop(true)
  rmSync(workspaceRoot, { recursive: true, force: true })
})

async function runJob(id: number, env: Record<string, string>, steps: Array<{ run: string, env?: Record<string, string> }>) {
  next = {
    id,
    token: `job-token-${id}`,
    key: 'env',
    checkout: { skip: true },
    env,
    steps: steps.map((step, index) => ({ name: `step ${index + 1}`, ...step })),
    run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
    repository_full_name: 'acme/widgets',
  }

  return await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot, tools: false })
}

describe('a job\'s env', () => {
  test('reaches every step, and a step\'s own env still wins', async () => {
    const env = resolveEnv({
      workflow: { BUN_VERSION: '1.4.2', LEVEL: 'workflow' },
      job: { LEVEL: 'job', PORT_API: '3011' },
    })

    const outcome = await runJob(9101, env, [
      { run: 'printf "%s %s %s" "$BUN_VERSION" "$LEVEL" "$PORT_API" > first.txt' },
      { run: 'printf "%s" "$LEVEL" > second.txt', env: { LEVEL: 'step' } },
    ])

    expect(outcome?.state).toBe('succeeded')
    expect(readFileSync(join(workspaceRoot, 'job-9101', 'first.txt'), 'utf8')).toBe('1.4.2 job 3011')
    expect(readFileSync(join(workspaceRoot, 'job-9101', 'second.txt'), 'utf8')).toBe('step')
  })

  test('is an expression context too, and its own values may be expressions', async () => {
    const outcome = await runJob(9102, { REF: '${{ github.ref }}', NAME: 'widgets' }, [
      { run: 'printf "%s" "$REF" > ref.txt' },
      { run: 'printf "%s" "${{ env.NAME }}" > name.txt' },
    ])

    expect(outcome?.state).toBe('succeeded')
    expect(readFileSync(join(workspaceRoot, 'job-9102', 'ref.txt'), 'utf8')).toBe('refs/heads/main')
    expect(readFileSync(join(workspaceRoot, 'job-9102', 'name.txt'), 'utf8')).toBe('widgets')
  })
})
