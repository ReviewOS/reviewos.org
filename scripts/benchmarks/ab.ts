/**
 * Two shas, both built, both served, measured against each other.
 *
 * `compare.ts` alternates traces between two URLs that are already running, and
 * says plainly that it does not build or serve anything - two servers, two
 * databases and two builds is a lot of machinery to get subtly wrong, and a
 * misconfigured server produces confident numbers. That reasoning is right and
 * it left the expensive half as a paragraph in a README, which is the half
 * people get wrong: an unbuilt side, a stale `node_modules`, a server that had
 * not finished starting when the first trace ran.
 *
 * So this does the machinery, and does it in the one way that removes the
 * failure modes rather than hiding them.
 *
 * ## What it does, and what each part is protecting against
 *
 * **Two git worktrees, at two shas.** Not two clones: a worktree shares the
 * object database, so standing one up is seconds rather than the size of the
 * repository, and there is no chance of the two sides being built from
 * different histories.
 *
 * **`node_modules` is symlinked, not installed.** Two installs is two chances
 * for the dependency trees to differ, which would mean measuring a dependency
 * bump rather than the change. The symlink means both sides run the *same*
 * dependencies, which is what makes the comparison about this repository.
 *
 * **Production mode, both sides.** A development server rebuilds on demand,
 * serves unminified assets and keeps a file watcher running. Measuring a scroll
 * on one measures the dev server as much as the diff engine.
 *
 * **The server is waited for, by asking it.** Not a sleep: a fixed wait is
 * either too short on a cold machine - where the first trace then measures a
 * server still starting - or wasted time on a warm one. It polls the URL that
 * is about to be measured until it answers.
 *
 * **Both worktrees are removed by the exact path this created**, and only
 * those. A benchmark that tidies up by walking a directory tree is a benchmark
 * that one day removes something else.
 *
 * ## Using it
 *
 *     bun scripts/benchmarks/ab.ts --base HEAD~1 --head HEAD \
 *       --path /owner/repo/pull/1/files --runs 3
 *
 * The path is a path rather than a URL, because the host and port belong to the
 * servers this starts. Everything else is handed to `compare.ts`, which is
 * where the alternation and the noise floor live.
 */

import type { Subprocess } from 'bun'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

interface Side {
  label: 'base' | 'head'
  sha: string
  directory: string
  port: number
  server: Subprocess | null
}

/** How long a side may take to build before this gives up on it. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000

/** How long a built side may take to answer before this gives up on it. */
const START_TIMEOUT_MS = 2 * 60 * 1000

const args = process.argv.slice(2)

function read(flag: string): string | undefined {
  const index = args.indexOf(flag)

  return index >= 0 ? args[index + 1] : undefined
}

async function run(command: string[], cwd: string, timeoutMs: number): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit', env: process.env })

  /*
   * A cancelled timer, not `Bun.sleep`.
   *
   * `Promise.race([child.exited, Bun.sleep(ten minutes)])` resolves the moment
   * the child does and then holds the process open for the rest of the ten
   * minutes, because the sleep is still a pending timer. This script exited
   * after two minutes of doing nothing for exactly that reason, and it looked
   * like `git worktree add` hanging.
   */
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<'timeout'>((settle) => {
    timer = setTimeout(() => settle('timeout'), timeoutMs)
  })

  try {
    const finished = await Promise.race([child.exited, timeout])

    if (finished === 'timeout') {
      child.kill('SIGKILL')
      throw new Error(`${command.join(' ')} in ${cwd} did not finish within ${Math.round(timeoutMs / 1000)}s`)
    }

    if (finished !== 0)
      throw new Error(`${command.join(' ')} in ${cwd} exited ${finished}`)
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
  }
}

/**
 * Wait for a side to answer, by asking the URL that is about to be measured.
 *
 * A fixed sleep is the usual answer and it is wrong in both directions: too
 * short on a cold machine, where the first trace measures a server still
 * starting, and wasted time on a warm one.
 */
async function ready(url: string, deadline: number): Promise<void> {
  for (;;) {
    if (Date.now() > deadline)
      throw new Error(`${url} did not answer within ${Math.round(START_TIMEOUT_MS / 1000)}s`)

    try {
      const answer = await fetch(url, { signal: AbortSignal.timeout(5000) })

      if (answer.ok || answer.status === 404)
        return
    }
    catch {
      // Not up yet. The deadline above is what ends this, not an error here.
    }

    await Bun.sleep(500)
  }
}

async function main(): Promise<void> {
  const baseSha = read('--base')
  const headSha = read('--head')
  const path = read('--path')
  const runs = read('--runs') ?? '3'
  const headed = args.includes('--headed')
  const keep = args.includes('--keep')
  /*
   * Stand both sides up, say where they are, and take them down again.
   *
   * The building and the tracing take twenty minutes and a browser; the
   * worktree, the symlink and the removal take two seconds and are the parts
   * that go wrong silently. `--dry-run` is how those get exercised without the
   * rest, which is what makes it possible to test this script at all.
   */
  const dryRun = args.includes('--dry-run')

  if (!baseSha || !headSha || !path) {
    console.error('Usage: bun scripts/benchmarks/ab.ts --base <sha> --head <sha> --path /owner/repo/pull/1/files [--runs 3] [--headed] [--keep]')
    process.exit(1)
    return
  }

  const root = process.cwd()
  const holder = mkdtempSync(join(tmpdir(), 'reviewos-ab-'))

  const sides: Side[] = [
    { label: 'base', sha: baseSha, directory: join(holder, 'base'), port: 4310, server: null },
    { label: 'head', sha: headSha, directory: join(holder, 'head'), port: 4311, server: null },
  ]

  /**
   * Removed by the exact paths this created, and nothing else.
   *
   * `git worktree remove` first, so git's own bookkeeping is updated rather
   * than left pointing at a directory that has gone; then the holder, by the
   * name `mkdtempSync` returned. Never by walking a tree.
   */
  const cleanUp = async (): Promise<void> => {
    for (const side of sides) {
      side.server?.kill('SIGTERM')

      if (keep)
        continue

      await run(['git', 'worktree', 'remove', '--force', side.directory], root, 60_000).catch(() => {})
    }

    if (!keep)
      rmSync(holder, { recursive: true, force: true })
  }

  process.on('SIGINT', () => { void cleanUp().then(() => process.exit(130)) })

  try {
    for (const side of sides) {
      console.error(`[${side.label}] worktree at ${side.sha}`)
      await run(['git', 'worktree', 'add', '--detach', side.directory, side.sha], root, 120_000)

      /*
       * The same dependencies on both sides, by construction.
       *
       * Two installs is two chances for the trees to differ, and a difference
       * there is measured as a difference in this repository - which is the one
       * thing an A/B of this repository must not do.
       */
      symlinkSync(join(root, 'node_modules'), join(side.directory, 'node_modules'), 'dir')

      if (dryRun) {
        console.error(`[${side.label}] ready at ${side.directory} (dry run: not built)`)
        continue
      }

      console.error(`[${side.label}] building`)
      await run(['./buddy', 'build'], side.directory, BUILD_TIMEOUT_MS)
    }

    if (dryRun) {
      console.error('dry run: both worktrees stood up and are about to be removed')
      return
    }

    for (const side of sides) {
      console.error(`[${side.label}] serving on ${side.port}`)
      side.server = Bun.spawn(['./buddy', 'serve', '--port', String(side.port)], {
        cwd: side.directory,
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, PORT: String(side.port), NODE_ENV: 'production' },
      })
    }

    const deadline = Date.now() + START_TIMEOUT_MS
    const urls = sides.map(side => `http://127.0.0.1:${side.port}${path}`)

    for (const url of urls)
      await ready(url, deadline)

    console.error('both sides answering; tracing')

    /*
     * Handed to `compare.ts` rather than reimplemented here. The alternation,
     * the medians and the noise floor are the parts that took measuring to get
     * right, and a second copy of them is a second set of thresholds to drift.
     */
    const compare = Bun.spawn([
      'bun',
      join(root, 'scripts/benchmarks/compare.ts'),
      '--base',
      urls[0]!,
      '--head',
      urls[1]!,
      '--runs',
      runs,
      ...(headed ? ['--headed'] : []),
    ], { cwd: root, stdout: 'inherit', stderr: 'inherit', env: process.env })

    const code = await compare.exited

    if (code !== 0)
      throw new Error(`compare.ts exited ${code}`)
  }
  finally {
    await cleanUp()
  }
}

if (import.meta.main)
  await main()
