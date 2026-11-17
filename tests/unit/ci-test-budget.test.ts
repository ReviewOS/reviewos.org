import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { machineSample, testWithBudget } from '../../.github/scripts/test-with-budget'

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


// The machine behind the suite.
//
// Two jobs in one run died with no test having failed: one signalled whole at
// 13m03s, one whose runner stopped answering and lost its log to the 30-minute
// ceiling. Nothing in the job recorded what the machine was doing, so the
// question stayed open. These pin the recording, not the diagnosis.
describe('what the supervisor records about the machine', () => {
  const fixtureSuite = (root: string, body: string) => {
    const fixture = join(root, 'suite.ts')
    writeFileSync(fixture, body)
    return [process.execPath, '--no-env-file', `--config=${resolve('.github/scripts/bunfig.toml')}`, fixture]
  }

  test('a sample is taken before the command can finish, so a quick death still says why', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-sample-first-'))
    try {
      let output = ''
      const status = await testWithBudget({
        command: fixtureSuite(root, `console.log('suite ran'); process.exit(0)\n`),
        timeoutMs: 5000, stopGraceMs: 100, outputDrainMs: 500,
        sampleMs: 60_000, sample: () => '[machine] first',
        write: chunk => { output += new TextDecoder().decode(chunk) },
      })
      expect(status).toBe(0)
      // Before the suite's own output, because the interval has not ticked yet
      // and the point is to have a reading at all.
      expect(output).toContain('[machine] first')
      expect(output.indexOf('[machine] first')).toBeLessThan(output.indexOf('suite ran'))
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 10_000)

  test('and again on the interval, which is the reading that shows a curve', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-sample-interval-'))
    try {
      let output = ''
      let taken = 0
      await testWithBudget({
        command: fixtureSuite(root, `await Bun.sleep(350); console.log('suite ran')\n`),
        timeoutMs: 5000, stopGraceMs: 100, outputDrainMs: 500,
        sampleMs: 50, sample: () => `[machine] sample ${++taken}`,
        write: chunk => { output += new TextDecoder().decode(chunk) },
      })
      expect(taken).toBeGreaterThan(2)
      expect(output).toContain('[machine] sample 3')
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 10_000)

  test('and stops once the command is done, rather than sampling a finished job', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-sample-stops-'))
    try {
      let taken = 0
      await testWithBudget({
        command: fixtureSuite(root, `process.exit(0)\n`),
        timeoutMs: 5000, stopGraceMs: 100, outputDrainMs: 100,
        sampleMs: 20, sample: () => `[machine] sample ${++taken}`,
        write: () => {},
      })
      const atExit = taken
      await Bun.sleep(150)
      expect(taken).toBe(atExit)
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 10_000)

  test('a reading the machine cannot give is left out rather than guessed at', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-sample-none-'))
    try {
      let output = ''
      // A sampler that cannot read /proc returns null, and a diagnostic that
      // can fail a job is worse than no diagnostic.
      const status = await testWithBudget({
        command: fixtureSuite(root, `console.log('suite ran'); process.exit(0)\n`),
        timeoutMs: 5000, stopGraceMs: 100, outputDrainMs: 500,
        sampleMs: 20, sample: () => null,
        write: chunk => { output += new TextDecoder().decode(chunk) },
      })
      expect(status).toBe(0)
      expect(output).toContain('suite ran')
      expect(output).not.toContain('[machine')
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 10_000)

  test('and recording can be turned off outright', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-sample-off-'))
    try {
      let taken = 0
      await testWithBudget({
        command: fixtureSuite(root, `process.exit(0)\n`),
        timeoutMs: 5000, stopGraceMs: 100, outputDrainMs: 100,
        sampleMs: 0, sample: () => `[machine] sample ${++taken}`,
        write: () => {},
      })
      expect(taken).toBe(0)
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 10_000)

  test('the real sampler puts a Linux machine on one readable line', () => {
    // A fixture /proc rather than this machine's, because the formatting is
    // what a person reads at 2am and a developer's Mac has no /proc to read.
    const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-proc-'))
    try {
      writeFileSync(join(root, 'meminfo'), [
        'MemTotal:       16373604 kB',
        'MemFree:          203392 kB',
        'MemAvailable:    1048576 kB',
        'SwapTotal:       4194304 kB',
        'SwapFree:         524288 kB',
      ].join('\n'))
      writeFileSync(join(root, 'loadavg'), '5.42 4.10 2.33 3/1234 56789\n')

      const line = machineSample(new Date('2026-11-17T12:00:00.000Z'), root, root)

      expect(line).toContain('[machine 2026-11-17T12:00:00.000Z]')
      expect(line).toContain('memory 1024/15990MiB available')
      expect(line).toContain('swap 512/4096MiB free')
      expect(line).toContain('load 5.42 4.10 2.33')
      expect(line).toMatch(/disk \d+MiB free/)
      // One line, because it is read next to twelve thousand others.
      expect(line).not.toContain('\n')
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('and says nothing at all when there is no /proc to read', () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-ci-proc-missing-'))
    try {
      expect(machineSample(new Date(), join(root, 'absent'), root)).toBeNull()
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('and reads this machine when this machine is the Linux one', () => {
    if (!existsSync('/proc/meminfo'))
      return

    expect(machineSample()).toMatch(/^\[machine .+\] memory \d+\/\d+MiB available, swap \d+\/\d+MiB free, disk \d+MiB free, load /)
  })
})
