import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { existsSync, symlinkSync, truncateSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

// Real runner execution and artifact HTTP bytes, without a control-plane DB.
// Server authorization/retention continue to be covered by artifact API tests.
for (const failure of ['', 'digest', 'upload', 'outside', 'symlink', 'destination-link', 'oversized', 'missing', 'archive'] as const) {
  test(`standard artifact actions round-trip the published application${failure ? ` and reject ${failure} failure` : ''}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-artifact-actions-'))
    const workspace = join(root, 'job-9814')
    mkdirSync(join(workspace, 'build'), { recursive: true })
    writeFileSync(join(workspace, 'build/app.zip'), 'synthetic-native-artifact')
    if (failure === 'symlink') symlinkSync(join(root, 'foreign.zip'), join(workspace, 'build/foreign.zip'))
    writeFileSync(join(root, 'foreign.zip'), 'private fixture bytes')
    if (failure === 'destination-link') symlinkSync(root, join(workspace, 'downloaded'))
    if (failure === 'oversized') truncateSync(join(workspace, 'build/app.zip'), 501 * 1024 * 1024)
    const uploadPath = failure === 'outside' ? '../foreign.zip' : failure === 'missing' ? 'absent/*.zip' : 'build/*.zip'
    let pending = true, logs = '', bytes = new Uint8Array(), uploadName = '', retention = '', authenticated = true
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/api/runner/artifacts') {
        authenticated &&= request.headers.get('authorization') === 'Bearer synthetic-artifact-lease'
        bytes = new Uint8Array(await request.arrayBuffer())
        uploadName = request.headers.get('x-artifact-name') ?? ''
        retention = request.headers.get('x-artifact-retention-days') ?? ''
        if (failure === 'upload') return Response.json({ error: 'refused' }, { status: 503 })
        return Response.json({ id: 37, name: uploadName, digest: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length }, { status: 201 })
      }
      const body = await request.json().catch(() => ({}))
      if (path === '/api/runner/artifacts/fetch') {
        authenticated &&= request.headers.get('authorization') === 'Bearer synthetic-artifact-lease'
        expect(body.name).toBe('simulator-42')
        const downloaded = failure === 'archive' ? gzipSync(await new Bun.Archive({ '../escaped.zip': 'unsafe archive' }).bytes()) : bytes
        return new Response(downloaded, { headers: { 'X-Artifact-Digest': failure === 'digest' ? '0'.repeat(64) : createHash('sha256').update(downloaded).digest('hex') } })
      }
      if (path.endsWith('/logs')) logs += String(body.content ?? '')
      if (path !== '/api/runner/claim' || !pending) return Response.json({ ok: true, held: true })
      pending = false
      return Response.json({ job: { id: 9814, token: 'synthetic-artifact-lease', key: 'artifacts', checkout: { skip: true }, repository_full_name: 'acme/widgets', run: { id: 42, number: 42, event: 'push', ref: 'refs/heads/main', head_sha: 'a'.repeat(40) }, steps: [
        { uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', id: 'upload', with: { name: 'simulator-${{ github.run_id }}', path: uploadPath, 'if-no-files-found': 'error', 'retention-days': 7 } },
        { run: 'rm -f build/app.zip' },
        { uses: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093', with: { name: 'simulator-${{ github.run_id }}', path: 'downloaded' } },
        { run: 'printf "%s" "${{ steps.upload.outputs.artifact-id }}" > artifact-id.txt' },
        { if: 'always()', run: 'printf cleaned > cleanup.txt' },
      ] } })
    } })
    try {
      const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'synthetic-runner', workspaceRoot: root, tools: false, policy: { defaultHost: 'github.com', allowedHosts: ['github.com'], requirePinnedSha: true, allowContainers: false } })
      expect(outcome?.state, logs).toBe(failure ? 'failed' : 'succeeded')
      if (!failure) {
        expect(readFileSync(join(workspace, 'downloaded/app.zip'), 'utf8')).toBe('synthetic-native-artifact')
        expect(readFileSync(join(workspace, 'artifact-id.txt'), 'utf8')).toBe('37')
        expect(existsSync(join(workspace, 'build/app.zip'))).toBe(false)
        expect(uploadName).toBe('simulator-42'); expect(retention).toBe('7'); expect(authenticated).toBe(true)
      }
      else {
        expect(existsSync(join(workspace, 'downloaded/app.zip'))).toBe(false)
        const reasons = { digest: 'digest mismatch', upload: 'upload returned HTTP 503', outside: 'workspace-relative', symlink: 'link outside', 'destination-link': 'link or non-directory', oversized: 'byte limit', missing: 'No files matched', archive: 'unsafe path' }
        expect(logs).toContain(reasons[failure])
        if (['digest', 'upload', 'destination-link', 'archive'].includes(failure)) expect(uploadName).toBe('simulator-42')
        else expect(uploadName).toBe('')
        expect(readFileSync(join(root, 'foreign.zip'), 'utf8')).toBe('private fixture bytes')
      }
      expect(readFileSync(join(workspace, 'cleanup.txt'), 'utf8')).toBe('cleaned')
      expect(existsSync(join(workspace, 'escaped.zip'))).toBe(false)
      expect(logs).not.toContain('synthetic-artifact-lease')
    }
    finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  }, 30_000)
}
