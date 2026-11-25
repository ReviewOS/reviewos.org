// A file's history reads Bloom filters, not every tree in the repository.
//
// `git log -50 -- <file>` on the production WebKit mirror took 24 seconds and
// 1.4GB for one page, and the renderer it ran under was OOM-killed three times
// in a morning (#19). Its commit-graph had come from plain `gc`, which never
// writes changed-path filters. These run the arguments nightly maintenance
// uses against real git and read git's own trace of whether it used them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedPathArguments, MAX_NEW_CHANGED_PATH_FILTERS } from '../../app/Actions/Repo/retention'

let root = ''
let repository = ''
let commits = 0
let traces = 0

function git(args: string[], input?: string): { ok: boolean, stdout: string, stderr: string } {
  const result = Bun.spawnSync(['git', '--git-dir', repository, ...args], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), env: { ...process.env, GIT_TRACE2_EVENT: '' } })
  return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

/** Append `count` commits to main, each touching one of a few dozen files. */
function addCommits(count: number): void {
  let stream = ''
  // Within one stream fast-import follows the branch itself; only a stream
  // continuing an existing branch has to name where it starts.
  const continuing = commits > 0
  for (let i = 0; i < count; i++, commits++) {
    const data = `line ${commits}\n`
    stream += `commit refs/heads/main\ncommitter A <a@example.com> ${1_700_000_000 + commits} +0000\ndata 1\nc\n`
    if (continuing && i === 0) stream += `from refs/heads/main^0\n`
    stream += `M 644 inline src/d${commits % 6}/f${commits % 40}.txt\ndata ${data.length}\n${data}\n`
  }
  const imported = git(['fast-import', '--quiet', '--force'], stream)
  expect(imported.ok, imported.stderr).toBe(true)
}

/**
 * git's own count of how the filters answered one file's history, or null when
 * git reported none, which it does when there are no filters to consult.
 *
 * Written to a file, not `/dev/stderr`: on Linux Bun gives a child sockets for
 * its stdio, and opening `/dev/stderr` on a socket fails, so git silently wrote
 * no trace on CI and every count read as zero.
 */
function bloomStatistics(): { filter_not_present: number, definitely_not: number } | null {
  const trace = join(root, `trace-${++traces}.json`)
  const result = Bun.spawnSync(['git', '--git-dir', repository, 'log', '-50', '--format=%H', 'main', '--', 'src/d3/f3.txt'], { env: { ...process.env, GIT_TRACE2_EVENT: trace } })
  expect(result.exitCode).toBe(0)
  const events = existsSync(trace) ? readFileSync(trace, 'utf8') : ''
  // A trace that never arrived would read as "no filters" and pass the
  // first test for the wrong reason, so its absence fails here.
  expect(events, 'git wrote no trace2 events').toContain('"event":"version"')
  const line = events.split('\n').find(l => l.includes('"category":"bloom"'))
  return line ? JSON.parse(line).value : null
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-path-filters-'))
  repository = join(root, 'history.git')
  Bun.spawnSync(['git', 'init', '--quiet', '--bare', repository])
  addCommits(400)
  // What every repository on the instance had: a graph from plain gc.
  expect(git(['gc', '--quiet']).ok).toBe(true)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('changed-path filters', () => {
  test('plain gc writes a commit-graph without them', () => {
    const before = bloomStatistics()

    expect(before?.definitely_not ?? 0).toBe(0)
  })

  test('the maintenance write adds them, and history uses them', () => {
    const written = git(changedPathArguments())
    expect(written.ok, written.stderr).toBe(true)

    const after = bloomStatistics()

    expect(after?.filter_not_present).toBe(0)
    expect(after?.definitely_not).toBeGreaterThan(300)
  })

  test('later commits packed by plain gc get them too, without another maintenance write', () => {
    addCommits(100)
    expect(git(['gc', '--quiet']).ok).toBe(true)

    const after = bloomStatistics()

    expect(after?.filter_not_present).toBe(0)
    expect(after?.definitely_not).toBeGreaterThan(400)
  })

  test('running it again with nothing to add keeps them', () => {
    expect(git(changedPathArguments()).ok).toBe(true)

    const again = bloomStatistics()

    expect(again?.filter_not_present).toBe(0)
    expect(again?.definitely_not).toBeGreaterThan(400)
  })

  test('an empty repository is not a failure', () => {
    const empty = join(root, 'empty.git')
    Bun.spawnSync(['git', 'init', '--quiet', '--bare', empty])

    expect(Bun.spawnSync(['git', '--git-dir', empty, ...changedPathArguments()]).exitCode).toBe(0)
  })

  test('replaces the graph and bounds one night\'s work', () => {
    const args = changedPathArguments()

    expect(args).toContain('--split=replace')
    expect(args).toContain(`--max-new-filters=${MAX_NEW_CHANGED_PATH_FILTERS}`)
  })
})
