import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

for (const compiled of [false, true]) for (const wrongRuntime of [false, true]) {
  test(`the ${compiled ? 'compiled' : 'source'} runner command ${wrongRuntime ? 'rejects a different compiler before building' : 'produces its qualified runtime with app preloads disabled'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-runner-runtime-'))
    try {
      const bin = join(root, 'bin'), entry = join(root, 'app/Actions/Runner/standalone.ts'), output = join(root, 'output')
      const marker = join(root, 'wrong-runtime-used')
      mkdirSync(bin)
      mkdirSync(dirname(entry), { recursive: true })
      writeFileSync(entry, 'console.log(Bun.version)\n')
      if (wrongRuntime) writeFileSync(join(bin, 'bun'), '#!/bin/sh\nif [ "$1" = --version ]; then echo 0.0.1; exit 0; fi\ntouch "$WRONG_RUNTIME_MARKER"\nexit 67\n', { mode: 0o755 })
      else symlinkSync(process.execPath, join(bin, 'bun'))
      const config = join(root, 'empty-bunfig.toml'), harness = join(root, 'command.ts')
      writeFileSync(config, '')
      writeFileSync(harness, `
import { cli } from ${JSON.stringify(fileURLToPath(import.meta.resolve('@stacksjs/cli')))}
import register from ${JSON.stringify(resolve('app/Commands/BuildRunner.ts'))}
const command = cli('runtime-test')
register(command)
await command.parse(process.argv)
`)
      const environment: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WRONG_RUNTIME_MARKER: marker }
      delete environment.BUN_BE_BUN
      let invocation = [process.execPath, '--no-env-file', `--config=${config}`, harness]
      if (compiled) {
        const program = join(root, 'compiled-command')
        const compiler = Bun.spawn([process.execPath, 'build', harness, '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--outfile', program], {
          cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe',
        })
        const [, errors, code] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited])
        expect({ code, stderr: code ? errors : '' }).toEqual({ code: 0, stderr: '' })
        invocation = [program]
      }
      const child = Bun.spawn([...invocation, 'build:runner', '--out', output], { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(existsSync(marker)).toBe(false)
      const executable = join(output, 'reviewos-runner')
      if (wrongRuntime) {
        expect(code).toBe(1)
        expect(stderr).toContain(`Runner builds require Bun ${Bun.version}`)
        expect(existsSync(executable)).toBe(false)
        return
      }
      expect({ code, stderr: code ? stderr : '' }).toEqual({ code: 0, stderr: '' })
      expect(existsSync(executable)).toBe(true)
      expect(stdout).toContain('Wrote ')
      const hostile = join(root, 'hostile')
      mkdirSync(hostile)
      writeFileSync(join(hostile, '.env'), 'REVIEWOS_RUNTIME_SENTINEL=must-not-autoload\n')
      writeFileSync(join(hostile, 'bunfig.toml'), 'preload = ["./untrusted.ts"]\n')
      writeFileSync(join(hostile, 'untrusted.ts'), 'throw new Error("untrusted preload executed")\n')
      const built = Bun.spawn([executable], { cwd: hostile, env: environment, stdout: 'pipe', stderr: 'pipe' })
      const [version, errors, status] = await Promise.all([new Response(built.stdout).text(), new Response(built.stderr).text(), built.exited])
      expect(status).toBe(0)
      expect(errors).toBe('')
      expect(version.trim()).toBe(Bun.version)
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 30_000)
}
