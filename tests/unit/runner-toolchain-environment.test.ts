// The runner protocol and a real toolchain child: observes the environment
// Pantry receives before workflow steps. It does not test Pantry's installer.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('toolchain setup receives workflow settings without the runner control environment or a substituted executable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-toolchain-env-'))
  try {
    const workspace = join(root, 'job-9159')
    const bin = join(root, 'bin')
    const substituted = join(root, 'substituted')
    mkdirSync(workspace)
    mkdirSync(bin)
    mkdirSync(substituted)
    writeFileSync(join(workspace, 'deps.yaml'), 'dependencies:\n  bun.com: 1.4.2\n')
    writeFileSync(join(bin, 'pantry'), `#!/bin/sh
printf '%s\\n' "$PANTRY_ENV_DEPS" "$SELECTED_REF" "\${DB_PASSWORD-unset}" "\${REVIEWOS_RUNNER_TOKEN-unset}" "$PATH" > toolchain-environment.txt
printf '%s\\n' '{"ok":true,"path":[]}'
`, { mode: 0o755 })
    writeFileSync(join(substituted, 'pantry'), '#!/bin/sh\nprintf substituted > wrong-tool.txt\nexit 1\n', { mode: 0o755 })
    const executor = fileURLToPath(new URL('../../app/Actions/Runner/localExecutor.ts', import.meta.url))
    const harness = join(root, 'exercise.ts')
    writeFileSync(harness, `import { runOnce } from ${JSON.stringify(executor)}
let claimed = false
const server = Bun.serve({ port: 0, async fetch(request) {
  await request.json()
  if (new URL(request.url).pathname === '/api/runner/claim' && !claimed) {
    claimed = true
    return Response.json({ job: {
      id: 9159, token: 'synthetic-job-token', key: 'toolchain', checkout: { skip: true },
      repository_full_name: 'acme/widgets',
      run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
      env: { PANTRY_ENV_DEPS: '0', SELECTED_REF: '\${{ github.ref }}', PATH: ${JSON.stringify(substituted)} },
      steps: [{ name: 'Use toolchain', run: 'test -f toolchain-environment.txt' }],
    } })
  }
  return Response.json({ ok: true, held: true })
} })
try {
  const result = await runOnce({ baseUrl: 'http://127.0.0.1:' + server.port, token: 'synthetic-runner',
    workspaceRoot: ${JSON.stringify(root)}, minimumFreeDiskMb: 0, maximumLoadPerCpu: 0 })
  if (result?.state !== 'succeeded') throw Error('Toolchain job did not succeed')
} finally { server.stop(true) }
`)
    const child = Bun.spawn([process.execPath, harness], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DB_PASSWORD: 'synthetic-host-secret', REVIEWOS_RUNNER_TOKEN: 'synthetic-control-token' },
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`Toolchain fixture failed: ${stdout}${stderr}`)
    expect(readFileSync(join(workspace, 'toolchain-environment.txt'), 'utf8').split('\n')).toEqual([
      '0', 'refs/heads/main', 'unset', 'unset', substituted, '',
    ])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
}, 40_000)
