import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

for (const fixture of [
  { name: 'a brief restart preserves verbose output', delay: 100, lines: 20000, expected: 'succeeded', ack: false, http: false, permanent: false },
  { name: 'a lost acknowledgment retries the original log sequence', delay: 100, lines: 1000, expected: 'succeeded', ack: true, http: false, permanent: false },
  { name: 'a proxy 503 retries without losing output', delay: 0, lines: 1000, expected: 'succeeded', ack: false, http: true, permanent: false },
  { name: 'persistent proxy failures stop a live producer and fail the job', delay: 0, lines: 1000, expected: 'failed', ack: false, http: true, permanent: true },
  { name: 'delivery beyond the output grace cannot report success with buffered output lost', delay: 2500, lines: 1000, expected: 'failed', ack: false, http: false, permanent: false },
]) test(fixture.name, async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-output-recovery-'))
  const received = new Map<number, string>()
  let disconnected = false
  let claimed = false
  const attempts: number[] = []
  let restarted: Promise<void> | undefined
  let server: ReturnType<typeof Bun.serve>
  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    const body: any = await request.json()
    if (path === '/api/runner/claim') {
      if (claimed) return Response.json({})
      claimed = true
      return Response.json({ job: {
        id: 9160, token: 'output-recovery-fixture', key: 'output', checkout: { skip: true },
        repository_full_name: 'acme/widgets',
        run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
        steps: [{ name: 'Write output', timeout_minutes: 0.2, run: fixture.permanent ? 'printf "OUTPUT-START\\n"; sleep 0.3; while :; do printf "still-writing\\n"; done' : 'printf "OUTPUT-START\\n"; sleep 0.3; i=0; while [ "$i" -lt ' + fixture.lines + ' ]; do printf "runner-output-%s\\n" "$i"; i=$((i+1)); done; printf "OUTPUT-END\\n"' }],
      } })
    }
    if (path === '/api/runner/logs') {
      if (String(body.content).includes('OUTPUT-START\n')) attempts.push(body.sequence)
      if (fixture.ack) received.set(body.sequence, body.content)
      if ((!disconnected || fixture.permanent) && String(body.content).includes('OUTPUT-START\n')) {
        if (fixture.http) {
          disconnected = true
          return Response.json({ error: 'temporarily unavailable' }, { status: 503 })
        }
        disconnected = true
        const port = server.port!
        server.stop(true)
        restarted = Bun.sleep(fixture.delay).then(() => { server = Bun.serve({ port, fetch }) })
      }
      else received.set(body.sequence, body.content)
    }
    return Response.json({ ok: true, held: true })
  }
  server = Bun.serve({ port: 0, fetch })
  try {
    const startedAt = Date.now()
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot: root, tools: false })
    expect(disconnected).toBe(true)
    expect(outcome?.state).toBe(fixture.expected)
    if (fixture.permanent) {
      expect(Date.now() - startedAt).toBeLessThan(8000)
      expect(outcome?.reason).toContain('output could not be delivered')
      expect(outcome?.reason).toContain('The instance did not accept step output after five attempts.')
    }
    if (fixture.delay > 2000)
      expect(outcome?.reason).toContain('Output delivery was still pending after the command exited.')
    expect(new Set(attempts).size).toBe(1)
    expect(attempts.length).toBeGreaterThan(1)
    const output = [...received.entries()].sort(([a], [b]) => a - b).map(([, content]) => content).join('')
    if (fixture.expected === 'succeeded') {
      expect(output).toContain('OUTPUT-START\n')
      expect(output).toContain(`runner-output-${fixture.lines - 1}\n`)
      expect(output).toContain('OUTPUT-END\n')
    }
  }
  finally {
    await restarted
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)
