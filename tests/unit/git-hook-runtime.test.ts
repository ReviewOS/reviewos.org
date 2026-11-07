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
      const child = Bun.spawn([file], { cwd: directory, stdin: Buffer.from('ref update\n'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(existsSync(marker)).toBe(false)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
