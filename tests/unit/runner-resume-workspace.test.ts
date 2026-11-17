// A restart-from-step meeting the workspace it actually got.
//
// `runner-resume.test.ts` pins the rule. This drives the real executor through
// a fake control plane, because the rule being right is worth nothing if the
// step loop does not act on it - and the way this bug reached production in
// the first place was a decision that looked correct everywhere except in the
// one place it ran.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'
import { workspaceJournal } from '../../app/Actions/Runner/workspaceJournal'

/**
 * A control plane that hands out one job whose first step is already done.
 *
 * `reused: true` with outputs is exactly what `ClaimJobAction` sends after a
 * restart-from-step: the step stays in the list so positions do not renumber,
 * and the flag says the machine need not run it.
 */
function controlPlane(jobId: number) {
  const logs: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.json().catch(() => ({})) as Record<string, unknown>

      if (path === '/api/runner/claim') {
        return Response.json({
          runner_id: 77,
          job: {
            id: jobId,
            token: crypto.randomUUID(),
            key: 'resume-fixture',
            tracking_id: crypto.randomUUID(),
            checkout: { skip: true },
            steps: [
              { name: 'install', run: 'echo INSTALLED-BY-THIS-ATTEMPT', reused: true, outputs: {} },
              { name: 'verify', run: 'echo VERIFIED' },
            ],
            run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'b'.repeat(40), trusted: true },
            repository_full_name: 'fixture/resume',
          },
        })
      }

      if (path === '/api/runner/logs')
        logs.push(String(body.content ?? ''))

      return Response.json({ ok: true, held: true })
    },
  })

  return { server, logs, baseUrl: `http://127.0.0.1:${server.port}` }
}

/*
 * The failure, through the executor.
 *
 * A journaled workspace is a new directory per attempt, so the install step's
 * work is in the directory the *earlier* attempt used. Honouring the skip here
 * is what left a deploy job running `./buddy` against an empty directory.
 */
test('a kept step runs anyway when the attempt journaled a workspace of its own', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-resume-fresh-'))
  const jobId = 8101
  const plane = controlPlane(jobId)
  const options = {
    baseUrl: plane.baseUrl,
    token: crypto.randomUUID(),
    workspaceJournalRoot: join(root, 'journals'),
    tools: false,
  }

  try {
    const outcome = await runOnce(options)
    const log = plane.logs.join('')

    expect(outcome?.state).toBe('succeeded')

    // It ran. This is the assertion the bug would fail.
    expect(log).toContain('INSTALLED-BY-THIS-ATTEMPT')
    expect(log).not.toContain('Kept from an earlier attempt')

    // And said why, before doing it.
    expect(log).toContain('new workspace of its own')
    expect(log.indexOf('new workspace of its own')).toBeLessThan(log.indexOf('INSTALLED-BY-THIS-ATTEMPT'))

    // The rest of the job is untouched by any of this.
    expect(log).toContain('VERIFIED')
  }
  finally {
    plane.server.stop(true)
    for (const record of workspaceJournal({ ...options, runnerId: 77 }, true)?.list() ?? [])
      rmSync(record.path, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

/*
 * The case that must keep working, or the fix is a feature removal.
 *
 * A configured workspace root gives `job-<id>` on every attempt, so the
 * earlier attempt's files are genuinely there and the skip is genuinely sound.
 */
test('and is still kept when the workspace carried over from the earlier attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-resume-carried-'))
  const jobId = 8102
  const workspaceRoot = join(root, 'workspaces')
  const carried = join(workspaceRoot, `job-${jobId}`)

  // What the earlier attempt left behind, which is the whole reason this
  // arrangement can skip anything.
  mkdirSync(carried, { recursive: true })
  writeFileSync(join(carried, 'node_modules.marker'), 'installed by attempt 1')

  const plane = controlPlane(jobId)

  try {
    const outcome = await runOnce({
      baseUrl: plane.baseUrl,
      token: crypto.randomUUID(),
      workspaceRoot,
      tools: false,
    })
    const log = plane.logs.join('')

    expect(outcome?.state).toBe('succeeded')

    expect(log).toContain('Kept from an earlier attempt')
    expect(log).not.toContain('INSTALLED-BY-THIS-ATTEMPT')
    expect(log).not.toContain('new workspace of its own')

    expect(log).toContain('VERIFIED')
  }
  finally {
    plane.server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
