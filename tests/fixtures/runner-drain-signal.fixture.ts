// runLoop and SIGUSR2, in a process of its own: a signal is process-wide.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const { runLoop } = await import('../../app/Actions/Runner/localExecutor')

const root = mkdtempSync(join(tmpdir(), 'reviewos-drain-'))
const claims: unknown[] = []
const messages: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === '/api/runner/claim') {
      claims.push(await request.json().catch(() => null))
      // Asked to stop locally after the first poll, while the loop idles.
      if (claims.length === 1)
        setTimeout(() => process.kill(process.pid, 'SIGUSR2'), 10)
      return Response.json({ job: null, runner_id: 7 })
    }
    return Response.json({})
  },
})
try {
  const started = Date.now()
  await runLoop({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'drain-fixture', workspaceRoot: root, idleMs: 200, say: line => messages.push(line) })
  console.log(JSON.stringify({ claims: claims.length, ms: Date.now() - started, messages }))
}
finally {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
