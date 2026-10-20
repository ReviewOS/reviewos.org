import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { limitedArgv, limitedCommand, limitsFrom } from '../../app/Actions/Runner/limits'

const fixtures: string[] = []
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

// Exercise the generated step boundary and the Linux kernel, not just the
// configured number. PROT_NONE mappings reserve addresses without touching
// their pages. This does not test resident-memory accounting or browser startup.
describe.skipIf(process.platform !== 'linux')('the finite default virtual-address budget', () => {
  test.each(['argv', 'command'])('%s permits runtime arenas while enforcing the inherited hard cap', async (mode) => {
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
        const arenaBytes = 1168231104512n // 1 TiB plus two 32 GiB guard regions.
        const arena = libc.symbols.mmap(null, arenaBytes, 0, 0x4022, -1, 0)
        assert.notEqual(arena, failed, 'The default must permit the runtime virtual arena')
        assert.equal(libc.symbols.munmap(arena, arenaBytes), 0)
        const before = Buffer.alloc(16)
        assert.equal(libc.symbols.getrlimit(9, before), 0)
        assert.equal(before.readBigUInt64LE(0), 2199023255552n)
        assert.equal(before.readBigUInt64LE(8), 2199023255552n)
        const oversizedBytes = 3298534883328n // 3 TiB, above the finite default.
        const oversized = libc.symbols.mmap(null, oversizedBytes, 0, 0x4022, -1, 0)
        const allocationError = read.i32(libc.symbols.__errno_location())
        if (oversized !== failed) libc.symbols.munmap(oversized, oversizedBytes)
        assert.equal(oversized, failed)
        assert.equal(allocationError, 12) // ENOMEM.
        const raised = Buffer.alloc(16)
        raised.writeBigUInt64LE(2199023259648n, 0)
        raised.writeBigUInt64LE(2199023259648n, 8)
        assert.equal(libc.symbols.setrlimit(9, raised), -1)
        assert.equal(read.i32(libc.symbols.__errno_location()), 1) // EPERM.
        const after = Buffer.alloc(16)
        assert.equal(libc.symbols.getrlimit(9, after), 0)
        assert.deepEqual(after, before)
        console.log(JSON.stringify({ arenaReleased: true, oversizedRejected: true, hardCapRetained: true, pagesTouched: false }))
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
    expect(JSON.parse(output)).toEqual({ arenaReleased: true, oversizedRejected: true, hardCapRetained: true, pagesTouched: false })
  }, 15_000)
})
