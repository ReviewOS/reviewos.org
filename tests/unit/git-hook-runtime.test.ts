import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { postReceiveScript, preReceiveScript } from '../../app/Actions/Git/hooks'

test('standalone callbacks do not run application preloads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reviewos-hook-runtime-'))
  try {
    const marker = join(directory, 'preload-ran')
    writeFileSync(join(directory, 'bunfig.toml'), 'preload = ["./preload.ts"]\n')
    writeFileSync(join(directory, 'preload.ts'), `await Bun.write(${JSON.stringify(marker)}, 'unexpected application bootstrap')`)
    for (const [name, script] of [['post', postReceiveScript('http://127.0.0.1:1/post')], ['pre', preReceiveScript('http://127.0.0.1:1/pre')]]) {
      const file = join(directory, name!)
      writeFileSync(file, script!); chmodSync(file, 0o755)
      const child = Bun.spawn([file], { cwd: directory, stdin: Buffer.from('ref update\n'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_WAL: 'off', PATH: `${dirname(process.execPath)}:${process.env.PATH}` } })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(existsSync(marker)).toBe(false)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('required WAL refuses unavailable, unsuccessful and malformed callbacks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reviewos-required-hook-'))
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/allow') return Response.json({ ok: true })
    if (path === '/refuse') return Response.json({ ok: false, refused: [{ reason: 'not recorded' }] })
    if (path === '/error') return new Response('unavailable', { status: 503 })
    if (path === '/malformed') return new Response('invalid json')
    return Response.json({})
  } })
  try {
    for (const mode of ['off', 'required']) {
      for (const path of ['/allow', '/refuse', '/error', '/malformed', '/unconfirmed', 'unreachable']) {
        const url = path === 'unreachable' ? 'http://127.0.0.1:1/pre' : `http://127.0.0.1:${server.port}${path}`
        const file = join(directory, 'pre-receive')
        writeFileSync(file, preReceiveScript(url)); chmodSync(file, 0o755)
        const child = Bun.spawn([file], { cwd: directory, stdin: Buffer.from('ref update\n'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_WAL: mode, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } })
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        const refused = path === '/refuse' || (mode === 'required' && path !== '/allow')
        expect(code, `${mode} ${path}: ${stderr}`).toBe(refused ? 1 : 0)
      }
    }
  } finally { server.stop(true); rmSync(directory, { recursive: true, force: true }) }
})
