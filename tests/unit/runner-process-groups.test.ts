import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.each(['unavailable', 'transient'])('group pruning works separately from %s process environment inspection', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-process-groups-'))
  const bin = join(root, 'bin')
  const attempt = join(root, 'environment-attempt')
  mkdirSync(bin)
  writeFileSync(join(bin, 'ps'), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = '-E' ] && { [ '${mode}' = 'unavailable' ] || [ ! -f '${attempt}' ]; }; then
    touch '${attempt}'
    exit 75
  fi
done
exec /bin/ps "$@"
`)
  chmodSync(join(bin, 'ps'), 0o700)
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../fixtures/runner-process-groups.fixture.ts'), mode], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(30_000),
    })
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(error)
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({ groupForgotten: true, metadataOnly: true, fullInspectionBlocked: process.platform === 'darwin' && mode === 'unavailable' })
  }
  finally { rmSync(root, { recursive: true, force: true }) }
}, 35_000)
