import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { limitedArgv, limitedCommand, limitsFrom } from '../../app/Actions/Runner/limits'

const fixtures: string[] = []
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

// Exercise the generated step boundary and the Linux kernel, not just the
// configured number. PROT_NONE mappings reserve addresses without touching
// their pages, which is what ThreadSanitizer, AddressSanitizer, Go and V8 do at
// startup - and TSan re-execs itself after raising RLIMIT_AS to unlimited,
// which a lowered hard limit refuses ("ThreadSanitizer setrlimit() failed",
// zig-anti-virus on the owned Linux executor).
describe.skipIf(process.platform !== 'linux')('no address-space ceiling by default', () => {
  test.each(['argv', 'command'])('%s lets a step reserve sanitizer-sized ranges and raise RLIMIT_AS to unlimited', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-address-space-'))
    fixtures.push(root)
    const program = join(root, 'reserve.js')
    writeFileSync(program, `
      const assert = require('node:assert/strict')
      const { dlopen, read } = require('bun:ffi')
      const libc = dlopen('libc.so.6', {
        getrlimit: { args: ['i32', 'ptr'], returns: 'i32' },
        setrlimit: { args: ['i32', 'ptr'], returns: 'i32' },
        mmap: { args: ['ptr', 'u64', 'i32', 'i32', 'i32', 'i64'], returns: 'u64' },
        munmap: { args: ['u64', 'u64'], returns: 'i32' },
        __errno_location: { args: [], returns: 'u64' },
      })
      try {
        const failed = 18446744073709551615n
        const infinity = 18446744073709551615n
        const limit = Buffer.alloc(16)
        assert.equal(libc.symbols.getrlimit(9, limit), 0)
        assert.equal(limit.readBigUInt64LE(8), infinity, 'the hard RLIMIT_AS must stay unlimited')
        // What TSan does before re-execing: soft and hard both to RLIM_INFINITY.
        const unlimited = Buffer.alloc(16)
        unlimited.writeBigUInt64LE(infinity, 0)
        unlimited.writeBigUInt64LE(infinity, 8)
        assert.equal(libc.symbols.setrlimit(9, unlimited), 0, 'setrlimit(RLIMIT_AS, unlimited) failed with ' + read.i32(libc.symbols.__errno_location()))
        const bytes = 3298534883328n // 3 TiB, past the old 2 TiB ceiling.
        const range = libc.symbols.mmap(null, bytes, 0, 0x4022, -1, 0)
        assert.notEqual(range, failed, 'a sanitizer-sized reservation must succeed')
        assert.equal(libc.symbols.munmap(range, bytes), 0)
        console.log(JSON.stringify({ hardUnlimited: true, raised: true, reserved: true }))
      }
      finally { libc.close() }
    `)
    const args = [process.execPath, '--no-env-file', program]
    const limits = limitsFrom({})
    const command = mode === 'argv'
      ? limitedArgv(args, limits)
      : ['/bin/sh', '-c', limitedCommand('exec "$@"', limits), 'test-step', ...args]
    const child = Bun.spawn(command, {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(10_000),
    })
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, error }).toEqual({ code: 0, error: '' })
    expect(JSON.parse(output)).toEqual({ hardUnlimited: true, raised: true, reserved: true })
  }, 15_000)
})
