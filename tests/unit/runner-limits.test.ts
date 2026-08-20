// Ceilings a step cannot raise.
//
// Not isolation - a step still runs as ordinary processes on the host, which is
// what the security review gates. What this stops is the ordinary accident: a
// test that forks until the box stops answering, a loop that writes a
// forty-gigabyte file. Those are not attacks, and they are what actually
// happens.
//
// The enforcement cases below run a real shell rather than asserting on a
// string, because a limit that is spelled correctly and does nothing is exactly
// the failure this file exists to catch.

import { describe, expect, test } from 'bun:test'
import { limitPrelude, limitedArgv, limitedCommand, limitsFrom } from '../../app/Actions/Runner/limits'

const none = { memoryMb: 0, processes: 0, fileSizeMb: 0, cpuSeconds: 0 }

describe('the settings', () => {
  test('are generous by default, because a limit that trips on ordinary work is one an operator removes', () => {
    const limits = limitsFrom({})

    expect(limits.memoryMb).toBe(4096)
    expect(limits.fileSizeMb).toBe(4096)
  })

  test('and the process ceiling is off, because it counts the whole user rather than the step', () => {
    /*
     * `RLIMIT_NPROC` is per real UID. On a machine where the runner shares a
     * user with anything else, a generous-looking number is already spent - and
     * turning it on by default made `/bin/sh: fork: Resource temporarily
     * unavailable` the second line of every build, which is how this test came
     * to exist.
     */
    expect(limitsFrom({}).processes).toBe(0)
    expect(limitsFrom({ CI_STEP_PROCESSES: '512' }).processes).toBe(512)
  })

  test('and CPU seconds are off, because they bound a different thing from wall time', () => {
    /*
     * A build that legitimately uses eight cores for two minutes has spent
     * sixteen CPU minutes without being slow. An operator who wants this knows
     * their workload.
     */
    expect(limitsFrom({}).cpuSeconds).toBe(0)
  })

  test('with an explicit zero meaning no ceiling, rather than falling back to the default', () => {
    // Otherwise "turn this off" would be a setting that cannot be expressed.
    expect(limitsFrom({ CI_STEP_FILE_SIZE_MB: '0' }).fileSizeMb).toBe(0)
    expect(limitsFrom({ CI_STEP_FILE_SIZE_MB: 'lots' }).fileSizeMb).toBe(4096)
  })
})

describe('the prelude', () => {
  test('sets the soft and hard limit together', () => {
    // Setting only the soft limit would let a step raise it back with one line,
    // which is a ceiling that asks to be respected rather than one that holds.
    expect(limitPrelude(limitsFrom({}))).toContain('-S -H')
  })

  test('and is empty when nothing is limited', () => {
    // A prelude of nothing but `true` would be a diff in every log for no
    // reason.
    expect(limitPrelude(none)).toBe('')
    expect(limitedCommand('make', none)).toBe('make')
    expect(limitedArgv(['prog', 'arg'], none)).toEqual(['prog', 'arg'])
  })

  test('and never fails the step over a limit the platform ignores', () => {
    // macOS accepts `-v` and does nothing with it; some shells refuse `-u`
    // inside a container that already capped it. A runner that refused to
    // start a build over that is one nobody keeps installed.
    for (const line of limitPrelude(limitsFrom({})).trim().split('\n'))
      expect(line).toContain('|| true')
  })
})

describe('the argv path, which has no shell', () => {
  test('introduces one around the limits and execs the program as arguments', () => {
    /*
     * A `uses:` step's arguments come off a workflow file. Putting them through
     * a shell would mean quoting them correctly forever, so they are passed
     * positionally - which never word-splits - and `exec` replaces the shell so
     * it does not linger as a parent that a signal has to travel through.
     */
    const argv = limitedArgv(['node', '--eval', 'console.log(1)'], limitsFrom({}))

    expect(argv[0]).toBe('/bin/sh')
    expect(argv[2]).toContain('exec "$@"')
    expect(argv.slice(4)).toEqual(['node', '--eval', 'console.log(1)'])
  })

  test('and an argument that would be a shell metacharacter survives it', async () => {
    // The property the positional form buys: this argument reaches the program
    // whole rather than being split, expanded, or run.
    const nasty = 'a b; touch /tmp/reviewos-should-not-exist $(whoami)'
    const argv = limitedArgv(['/bin/echo', nasty], limitsFrom({}))

    const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore' })
    const said = await new Response(child.stdout).text()

    await child.exited

    expect(said.trim()).toBe(nasty)
  })
})

describe('what the ceilings actually do', () => {
  test('a step cannot write a file larger than it was allowed', async () => {
    /*
     * Run for real rather than asserted as a string: a limit spelled correctly
     * that does nothing is the failure this whole file exists to catch.
     *
     * One megabyte, then two written into it. The shell is killed by SIGXFSZ or
     * the write fails - either way the step does not succeed, which is the
     * property. `dd` reports its own failure too, so the exit status is
     * non-zero on both platforms.
     */
    const command = limitedCommand(
      'dd if=/dev/zero of=big.bin bs=1048576 count=2 2>/dev/null',
      { ...none, fileSizeMb: 1 },
    )

    const child = Bun.spawn(['/bin/sh', '-c', command], {
      cwd: '/tmp',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    expect(await child.exited).not.toBe(0)
  })

  test('and one that is allowed the space writes it', async () => {
    // The other half, so the test above is proving a limit rather than proving
    // `dd` is broken.
    const command = limitedCommand(
      'dd if=/dev/zero of=small.bin bs=1048576 count=2 2>/dev/null',
      { ...none, fileSizeMb: 64 },
    )

    const child = Bun.spawn(['/bin/sh', '-c', command], {
      cwd: '/tmp',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    expect(await child.exited).toBe(0)
  })

  test('and a step cannot raise the ceiling it was given', async () => {
    /*
     * The whole reason both limits are set. Lowering a soft limit is allowed to
     * any process; raising it past the hard limit is not - so a step that tries
     * gets an error and still cannot write the file.
     */
    const command = limitedCommand(
      'ulimit -f 1000000 2>/dev/null; dd if=/dev/zero of=raised.bin bs=1048576 count=2 2>/dev/null',
      { ...none, fileSizeMb: 1 },
    )

    const child = Bun.spawn(['/bin/sh', '-c', command], {
      cwd: '/tmp',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    expect(await child.exited).not.toBe(0)
  })
})
