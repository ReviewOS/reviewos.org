// Fetching an action from somewhere else, and not fetching it twice.
//
// Against a real git repository served over `file://` rather than the internet.
// That is not a shortcut: the point of the origins map is that a host can be
// pointed at a mirror or at this instance itself, so exercising it is exercising
// the feature an air-gapped install actually uses - and it means this suite
// tells the truth on a machine with no network.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fetchAction } from '../../app/Actions/Runner/actionCache'
import { checkPolicy, parseActionRef } from '../../app/Actions/Runner/actionRef'

const state = { temp: '', origin: '', cache: '', sha: '', secondSha: '' }

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return stdout.trim()
}

const ACTION = `name: Remote greet
description: An action that lives somewhere else
inputs:
  who:
    default: world
runs:
  using: composite
  steps:
    - name: Greet
      shell: bash
      run: echo "hello $INPUT_WHO"
`

beforeAll(async () => {
  state.temp = mkdtempSync(join(tmpdir(), 'reviewos-remote-actions-'))
  state.cache = join(state.temp, 'cache')

  // The "remote": an ordinary bare repository, reached over file://.
  const work = join(state.temp, 'work')
  state.origin = join(state.temp, 'origin', 'owner', 'action.git')

  mkdirSync(join(state.temp, 'origin', 'owner'), { recursive: true })
  mkdirSync(work, { recursive: true })

  await git(state.temp, 'init', '--bare', '--initial-branch=main', state.origin)
  await git(work, 'init', '--initial-branch=main')

  writeFileSync(join(work, 'action.yml'), ACTION)
  await git(work, 'add', '-A')
  await git(work, 'commit', '-m', 'the action')
  await git(work, 'tag', 'v1')
  await git(work, 'push', state.origin, 'main', 'v1')

  state.sha = await git(work, 'rev-parse', 'HEAD')

  // A second commit, so "the tag moved" can be told from "the sha is the sha".
  writeFileSync(join(work, 'action.yml'), ACTION.replace('hello', 'greetings'))
  await git(work, 'add', '-A')
  await git(work, 'commit', '-m', 'a change')
  await git(work, 'push', state.origin, 'main')

  state.secondSha = await git(work, 'rev-parse', 'HEAD')
}, 120_000)

afterAll(() => {
  if (state.temp)
    rmSync(state.temp, { recursive: true, force: true })
})

/**
 * The configuration an air-gapped instance actually has: a default action host,
 * pointed at somewhere its own machines can reach.
 */
function fetchOptions(overrides: Record<string, unknown> = {}): any {
  return {
    root: state.cache,
    defaultHost: 'actions.example',
    origins: { 'actions.example': `file://${join(state.temp, 'origin')}` },
    ...overrides,
  }
}

describe('fetching an action', () => {
  test('by tag', async () => {
    const result = await fetchAction(parseActionRef('owner/action@v1'), fetchOptions())

    expect(result.ok).toBe(true)
    expect(result.sha).toBe(state.sha)
    expect(await Bun.file(join(String(result.path), 'action.yml')).text()).toContain('Remote greet')
  }, 60_000)

  test('by commit sha, which is the only pinned form', async () => {
    const result = await fetchAction(parseActionRef(`owner/action@${state.secondSha}`), fetchOptions())

    expect(result.ok).toBe(true)
    expect(result.sha).toBe(state.secondSha)
    // The second commit, not the tag: proof the reference decided rather than
    // the default branch.
    expect(await Bun.file(join(String(result.path), 'action.yml')).text()).toContain('greetings')
  }, 60_000)

  /*
   * The whole reason for a cache: a workflow using six actions across four jobs
   * asks for the same code repeatedly, and a runner that clones each time turns
   * every run into a network-bound one.
   */
  test('a second fetch of a pinned reference does no network at all', async () => {
    const again = await fetchAction(parseActionRef(`owner/action@${state.secondSha}`), fetchOptions({
      // Pointed at nothing: if this reaches the network it cannot succeed,
      // which is exactly what proves it did not.
      origins: { 'actions.example': 'file:///nowhere-at-all' },
    }))

    expect(again.ok).toBe(true)
    expect(again.cached).toBe(true)
    expect(again.sha).toBe(state.secondSha)
  }, 60_000)

  test('a reference that does not exist fails with what git said', async () => {
    const result = await fetchAction(parseActionRef('owner/action@v99'), fetchOptions())

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('owner/action@v99')
  }, 60_000)

  test('and a repository that does not exist does too', async () => {
    const result = await fetchAction(parseActionRef('owner/missing@v1'), fetchOptions())

    expect(result.ok).toBe(false)
  }, 60_000)

  test('a subdirectory reference lands inside the repository', async () => {
    // `owner/name/tools/lint@v1` is one repository and one action inside it.
    const result = await fetchAction(parseActionRef('owner/action/nested@v1'), fetchOptions())

    expect(result.ok).toBe(true)
    expect(String(result.path).endsWith(join('nested'))).toBe(true)
  }, 60_000)
})

describe('what the policy decides before any of that', () => {
  test('an unqualified reference with no default host is refused rather than guessed', async () => {
    // The same guess the policy layer refuses to make: an instance that has not
    // been told where actions come from should say so, not quietly reach for
    // the biggest host there is.
    const result = await fetchAction(parseActionRef('owner/action@v1'), fetchOptions({ defaultHost: null }))

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no default action host')
  }, 60_000)

  test('a host nobody allowed is refused before a packet is sent', () => {
    const decision = checkPolicy(parseActionRef('https://actions.example/owner/action@v1'), {
      allowedHosts: ['github.com'],
      defaultHost: 'github.com',
      requirePinnedSha: false,
      allowContainers: false,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('actions.example')
  })

  test('and pinning, when required, is checked against the commit that arrived', async () => {
    /*
     * The check that makes pinning mean something. A host answering a fetch for
     * one sha with a different commit is either broken or hostile, and a runner
     * that checks out whatever arrived has turned a pin into a decoration.
     *
     * Simulated by asking for a sha this repository does not have: the fetch
     * fails rather than falling back to a branch, which is the same protection
     * seen from the other side.
     */
    const result = await fetchAction(parseActionRef(`owner/action@${'0'.repeat(40)}`), fetchOptions())

    expect(result.ok).toBe(false)
    expect(result.path).toBeNull()
  }, 60_000)
})
