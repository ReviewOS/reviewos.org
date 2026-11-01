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

test('names why pantry gave no environment instead of its progress header', async () => {
  const { toolchainFailure, PANTRY_ENV_JSON_VERSION } = await import('../../app/Actions/Runner/localExecutor')

  // An install that failed: its report says why, on stdout.
  expect(toolchainFailure('{"ok":false,"error":"pantry install failed"}', 'pantry install v0.11.154\n\n- x@1 (PackageNotFound)'))
    .toContain('pantry install failed')

  // A pantry too old for the flags.
  const old = toolchainFailure('', "Error: Unknown option '--install'\nError: error.UnknownOption")
  expect(old).toContain('predates `pantry env --json`')
  expect(old).toContain(PANTRY_ENV_JSON_VERSION)

  // Anything else shows the end of stderr, not its first line.
  const other = toolchainFailure('', 'pantry install v0.11.154\n\nline a\nline b\nline c\nthe real reason')
  expect(other).toContain('the real reason')
  expect(other).not.toContain('pantry install v0.11.154')
})

test('puts a pantry-provided PATH ahead of the job, and reports a failed install without using it', async () => {
  workspace = mkdtempSync(join(tmpdir(), 'reviewos-toolchain-'))
  writeFileSync(join(workspace, 'deps.yaml'), 'dependencies:\n  bun.sh: ^1\n')

  const fake = (body: string) => {
    const path = join(workspace, 'fake-pantry')
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })

    return path
  }

  const said: string[] = []
  const provided = await provideTools(workspace, async (line) => { said.push(line) }, fake(`echo '{"ok":true,"path":["/a/bin","/b/bin"],"dependencies":["bun.sh 1.4.4"]}'`))
  expect(provided).toBe('/a/bin:/b/bin')
  expect(said.join('')).toContain('Using bun.sh 1.4.4')

  const failed: string[] = []
  const none = await provideTools(workspace, async (line) => { failed.push(line) }, fake(`echo '{"ok":false,"path":["/a/bin"],"error":"not installed: bun.sh"}'; exit 1`))
  expect(none).toBe('')
  expect(failed.join('')).toContain('not installed: bun.sh')
})
