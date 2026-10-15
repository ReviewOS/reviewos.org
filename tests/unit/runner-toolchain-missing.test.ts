// A repository that declares its tools, on a runner with no pantry.
//
// The ordinary case for a machine somebody provides for one project's CI:
// `provideTools` was written to say so once and carry on, but `Bun.spawn`
// throws for an executable that is not on PATH instead of exiting non-zero,
// so that branch was never reached and every job of a repository with a
// deps.yaml failed before its first step ("Executable not found in $PATH:
// pantry") - found on stacksjs/hq.training's own runner.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provideTools } from '../../app/Actions/Runner/localExecutor'

let workspace = ''

afterEach(() => {
  if (workspace)
    rmSync(workspace, { recursive: true, force: true })
})

test('says pantry is not here and carries on, rather than failing the job', async () => {
  workspace = mkdtempSync(join(tmpdir(), 'reviewos-toolchain-'))
  writeFileSync(join(workspace, 'deps.yaml'), 'dependencies:\n  bun.sh: ^1\n')
  const said: string[] = []
  // A name no machine has: Bun resolves executables against the PATH it was
  // started with, so emptying PATH here would not hide this one's pantry.
  const prepended = await provideTools(workspace, async (line) => { said.push(line) }, 'reviewos-no-such-pantry')

  expect(prepended).toBe('')
  expect(said.join('')).toContain('pantry is not installed here')
  expect(said.at(-1)).toBe('::endgroup::\n')
})
