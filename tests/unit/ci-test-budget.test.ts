import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { testWithBudget } from '../../.github/scripts/test-with-budget'

// This public supervisor seam exercises real process exit, output and an
// unsettled module. It cannot explain which application module hung in CI.
for (const code of [0, 7]) {
  test(`the CI suite preserves command output and exit ${code}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-budget-'))
    try {
      const fixture = join(root, 'suite.ts')
      writeFileSync(fixture, `console.log('original suite output'); process.exit(${code})\n`)
      let output = ''
      const status = await testWithBudget({ command: [process.execPath, '--no-env-file', `--config=${resolve('.github/scripts/bunfig.toml')}`, fixture], timeoutMs: 5000, stopGraceMs: 100, outputDrainMs: 500,
        write: chunk => { output += new TextDecoder().decode(chunk) } })
      expect(status).toBe(code)
      expect(output).toContain('original suite output')
      expect(output).not.toContain('::error::')
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 10_000)
}

test('an unsettled module fails inside the CI deadline and retains its last progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-budget-hang-'))
  try {
    const fixture = join(root, 'suite.ts')
    writeFileSync(fixture, `console.log('never-resolves.test.ts:'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {})\n`)
    let output = ''
    const started = Date.now()
    const status = await testWithBudget({ command: [process.execPath, '--no-env-file', `--config=${resolve('.github/scripts/bunfig.toml')}`, fixture], timeoutMs: 500, stopGraceMs: 100, outputDrainMs: 500,
      write: chunk => { output += new TextDecoder().decode(chunk) } })
    expect(status).toBe(124)
    expect(output).toContain('never-resolves.test.ts:')
    expect(output).toContain('::error::The test suite exceeded its 500ms budget')
    expect(Date.now() - started).toBeLessThan(5000)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
}, 10_000)


test('a descendant holding output cannot hold a finished CI step open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-budget-output-'))
  const pidFile = join(root, 'owned-escaped.pid')
  try {
    const fixture = join(root, 'suite.ts')
    const escaped = join(root, 'escaped.ts')
    writeFileSync(escaped, `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); console.log('owned escaped writer'); setInterval(() => {}, 1000)\n`)
    const config = `--config=${resolve('.github/scripts/bunfig.toml')}`
    writeFileSync(fixture, `Bun.spawn([process.execPath, '--no-env-file', ${JSON.stringify(config)}, ${JSON.stringify(escaped)}], { detached: true, stdout: 'inherit', stderr: 'inherit' }); while (!await Bun.file(${JSON.stringify(pidFile)}).exists()) await Bun.sleep(10); process.exit(0)\n`)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'bun suite.ts' } }))
    const started = Date.now()
    const child = Bun.spawn([process.execPath, '--no-env-file', config, resolve('.github/scripts/test-with-budget.ts')], {
      cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 5000,
    })
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const output = stdout + stderr
    expect(status).toBe(1)
    expect(output).toContain('owned escaped writer')
    expect(output).toContain('::error::Test output did not close cleanly')
    expect(Date.now() - started).toBeLessThan(5000)
  }
  finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(-pid, 'SIGKILL') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)
