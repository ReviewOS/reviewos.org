import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

test('a transient log connection failure does not stop draining a noisy step', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-log-reconnect-'))
  const workspace = join(root, 'job-9812')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'bunfig.toml'), 'preload = []\n')
  writeFileSync(join(workspace, 'writer.ts'), `process.stderr.write('transport-fixture-start\\n')
for (let index = 0; index < 128; index++) process.stderr.write('x'.repeat(8192) + '\\n')
process.stderr.write('transport-fixture-end\\n')
await Bun.write('writer-finished', 'yes')
`)
  let pending = true
  let disconnected = false
  let restart: Promise<void> | undefined
  let logs = ''
  let port = 0
  let server: ReturnType<typeof Bun.serve>
  const serve = () => Bun.serve({
    hostname: '127.0.0.1', port,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.json().catch(() => ({}))
      if (path === '/api/runner/logs') {
        if (!disconnected && String(body.content).includes('transport-fixture-start')) {
          disconnected = true
          server.stop(true)
          restart = Bun.sleep(50).then(() => { server = serve() })
          return Response.json({ ok: true })
        }
        logs += String(body.content ?? '')
      }
      if (path === '/api/runner/claim') {
        if (!pending) return Response.json({})
        pending = false
        return Response.json({ job: {
          id: 9812, token: 'fixture-job-token', key: 'noisy', checkout: { skip: true },
          steps: [{ run: 'bun writer.ts', timeout_minutes: 0.1 }],
          run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
          repository_full_name: 'acme/widgets',
        } })
      }
      return Response.json({ ok: true, held: true })
    },
  })
  server = serve()
  port = server.port!
  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${port}`, token: 'fixture-runner', workspaceRoot: root, tools: false })
    expect(disconnected).toBe(true)
    expect(outcome?.state).toBe('succeeded')
    expect(existsSync(join(workspace, 'writer-finished'))).toBe(true)
    expect(logs).toContain('transport-fixture-start')
    expect(logs).toContain('transport-fixture-end')
  }
  finally {
    await restart
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
