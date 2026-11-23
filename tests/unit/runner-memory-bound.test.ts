// The memory bound a job's processes run under.
//
// It replaced an address-space ceiling (`ulimit -v`, RLIMIT_AS), which bounded
// nothing a job actually uses and broke every program that reserves a large
// virtual range up front: ThreadSanitizer refused to start on the owned Linux
// executor with "setrlimit() failed". A cgroup's `memory.max` counts the pages
// a job really holds, which is the thing that takes a box down.

import { describe, expect, test } from 'bun:test'
import { boundedArgv, probeCommand, readProbe, scopeEnvironment } from '../../app/Actions/Runner/memoryBound'

describe('the scope a step runs in', () => {
  test('is a transient systemd user scope with MemoryMax, in front of the step', () => {
    expect(boundedArgv(['/bin/sh', '-c', 'make'], { memoryMb: 4096, swap: true })).toEqual([
      'systemd-run', '--user', '--scope', '--quiet', '--collect',
      '--property=MemoryMax=4096M', '--property=MemorySwapMax=0',
      '--', '/bin/sh', '-c', 'make',
    ])
  })

  test('without the swap line where the kernel does not account swap', () => {
    expect(boundedArgv(['make'], { memoryMb: 4096, swap: false })).toEqual([
      'systemd-run', '--user', '--scope', '--quiet', '--collect',
      '--property=MemoryMax=4096M', '--', 'make',
    ])
  })

  test('and nothing at all when there is no bound to apply', () => {
    expect(boundedArgv(['make'], null)).toEqual(['make'])
    expect(boundedArgv(['make'], { memoryMb: 0, swap: true })).toEqual(['make'])
  })
})

describe('the probe', () => {
  test('asks a scope for the limit the kernel actually holds', () => {
    const argv = probeCommand(true)

    expect(argv.slice(0, 5)).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect'])
    expect(argv).toContain('--property=MemoryMax=64M')
    expect(argv.join(' ')).toContain('memory.max')
  })

  test('trusts only a scope whose memory.max is the limit it asked for', () => {
    // A user manager without the memory controller delegated accepts the
    // property and enforces nothing; reading memory.max is how that shows.
    expect(readProbe({ code: 0, stdout: '67108864\n' })).toBe(true)
    expect(readProbe({ code: 0, stdout: 'max\n' })).toBe(false)
    expect(readProbe({ code: 0, stdout: 'cat: memory.max: No such file\n' })).toBe(false)
    expect(readProbe({ code: 1, stdout: '67108864\n' })).toBe(false)
  })
})

describe('the environment systemd-run needs', () => {
  test('borrows the user manager\'s address from the runner when the job has none', () => {
    expect(scopeEnvironment({ PATH: '/bin' }, { XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', HOME: '/home/runner' }))
      .toEqual({ PATH: '/bin', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })
  })

  test('and leaves a job\'s own values alone', () => {
    expect(scopeEnvironment({ XDG_RUNTIME_DIR: '/job' }, { XDG_RUNTIME_DIR: '/run/user/1000' })).toEqual({ XDG_RUNTIME_DIR: '/job' })
  })
})
