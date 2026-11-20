import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

// Real execution and HTTP artifact bytes catch retry-name collisions. The
// authenticated claim route is covered separately against the test database.
test('job retries publish and download distinct immutable artifacts within one workflow attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-artifact-retry-'))
  const artifacts = new Map<string, Uint8Array>()
  let attempt = 1, pending = true, logs = ''
  const name = 'simulator-${{ github.run_id }}-${{ github.run_attempt }}-${{ reviewos.job_attempt }}'
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/runner/artifacts') {
      const key = request.headers.get('x-artifact-name') ?? ''
      const bytes = new Uint8Array(await request.arrayBuffer())
      const digest = createHash('sha256').update(bytes).digest('hex')
      const previous = artifacts.get(key)
      if (previous && createHash('sha256').update(previous).digest('hex') !== digest)
        return Response.json({ error: 'Immutable artifact already exists' }, { status: 409 })
      artifacts.set(key, bytes)
      return Response.json({ id: artifacts.size, name: key, digest, size_bytes: bytes.length }, { status: 201 })
    }
    const body = await request.json().catch(() => ({}))
    if (path === '/api/runner/artifacts/fetch') {
      const bytes = artifacts.get(body.name)
      return bytes ? new Response(bytes, { headers: { 'X-Artifact-Digest': createHash('sha256').update(bytes).digest('hex') } }) : new Response('Missing', { status: 404 })
    }
    if (path.endsWith('/logs')) logs += String(body.content ?? '')
    if (path !== '/api/runner/claim' || !pending) return Response.json({ ok: true, held: true })
    pending = false
    return Response.json({ job: { id: 9815, attempt, token: 'synthetic-retry-lease', key: 'native', checkout: { skip: true }, repository_full_name: 'acme/widgets', run: { id: 42, attempt: 1, number: 42, event: 'push', ref: 'refs/heads/main', head_sha: 'a'.repeat(40) }, steps: [
      { uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', with: { name, path: 'build/app.zip', 'if-no-files-found': 'error' } },
      { uses: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093', with: { name, path: 'downloaded' } },
      { run: 'printf "%s" "${{ github.run_attempt }}" > run-attempt.txt' },
      { run: attempt === 1 ? 'exit 1' : 'true' },
    ] } })
  } })
  try {
    for (attempt = 1; attempt <= 2; attempt++) {
      const workspace = join(root, 'job-9815')
      rmSync(workspace, { recursive: true, force: true })
      mkdirSync(join(workspace, 'build'), { recursive: true })
      writeFileSync(join(workspace, 'build/app.zip'), attempt === 1 ? 'original application' : 'rebuilt application')
      pending = true
      const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'synthetic-runner', workspaceRoot: root, tools: false, policy: { defaultHost: 'github.com', allowedHosts: ['github.com'], requirePinnedSha: true, allowContainers: false } })
      expect(outcome?.state, logs).toBe(attempt === 1 ? 'failed' : 'succeeded')
      expect(readFileSync(join(workspace, 'downloaded/app.zip'), 'utf8')).toBe(attempt === 1 ? 'original application' : 'rebuilt application')
      expect(readFileSync(join(workspace, 'run-attempt.txt'), 'utf8')).toBe('1')
    }
    expect([...artifacts.keys()]).toEqual(['simulator-42-1-1', 'simulator-42-1-2'])
    expect(artifacts.get('simulator-42-1-1')).not.toEqual(artifacts.get('simulator-42-1-2'))
    expect(logs).not.toContain('synthetic-retry-lease')
  }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
}, 30_000)
