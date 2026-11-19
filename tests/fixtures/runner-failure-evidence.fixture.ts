// Exercise the existing runner HTTP seam in a child so PATH never changes for
// another suite. Only the external process-table command is made unavailable.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

const root = process.argv[2]!
if (!root) throw new Error('A disposable runner workspace is required')
const trigger = join(root, 'fail-ps')
const mode = process.argv[3]
let pending = true
const artifacts: { name: string | null, body: string, authorized: boolean }[] = []
const events: string[] = []
const reports: any[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/api/runner/artifacts') {
    events.push('artifact')
    artifacts.push({ name: request.headers.get('x-artifact-name'), body: await request.text(), authorized: request.headers.get('authorization') === 'Bearer fixture-job' })
    if (mode === 'late') writeFileSync(trigger, '')
    return Response.json({ ok: true }, { status: 201 })
  }
  const body = await request.json().catch(() => ({}))
  if (path === '/api/runner/report') { events.push('report'); reports.push(body) }
  if (path !== '/api/runner/claim' || !pending) return Response.json({ ok: true, held: true })
  pending = false
  return Response.json({ job: {
    id: 9060, token: 'fixture-job', key: 'evidence', checkout: { skip: true },
    repository_full_name: 'acme/widgets', artifact_paths: ['failure.txt'],
    run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'a'.repeat(40) },
    steps: [{ name: 'real failing command', run: `printf 'original failure evidence' > failure.txt; ${mode === 'late' ? '' : `touch '${trigger}';`} exit 3` }],
  } })
} })
const bystander = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' })
try {
  const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'fixture-runner', workspaceRoot: root, tools: false })
  let bystanderAlive = true
  try { process.kill(bystander.pid, 0) }
  catch { bystanderAlive = false }
  console.log(JSON.stringify({ outcome, artifacts, events, reports, bystanderAlive, attemptPreserved: existsSync(join(root, '.reviewos-attempts/9060.json')) }))
}
finally {
  bystander.kill()
  await bystander.exited
  server.stop(true)
}
