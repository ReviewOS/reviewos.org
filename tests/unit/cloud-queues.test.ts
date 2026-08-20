// Every queue a job uses has a worker on the box, and that worker can start.
//
// This is the test for the failure that took the mirrors down, and the reason
// it is worth a test is that the failure is *invisible*. A queue nothing works
// is not an error: nothing is logged, the queue depth for that name climbs, and
// the feature behind it stops happening.
//
// It has now failed twice, differently.
//
// The first time there were no workers at all. `scheduler: true` was set, so
// `MirrorSweepJob` was enqueued on the `mirrors` queue every five minutes - and
// nothing ever ran it, so no `MirrorSyncJob` was ever created and every mirror
// on the instance froze with a clean record.
//
// The second time there were seven, declared through ts-cloud's `queues`, and
// every one of them was dead. The Stacks driver writes their `ExecStart` as
// `bun <release>/storage/framework/core/buddy/src/cli.ts queue:work`, and this
// application has no vendored `storage/framework/core` - so all seven crash-
// looped on `Module not found` at five-second intervals for as long as they
// existed, while `systemctl` reported them `activating (auto-restart)` and
// `/api/health` reported the queue fine. A queue nothing fills has no depth.
//
// So both halves are checked here: that the queues are covered, and that the
// command doing the covering names a file this repository actually ships.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tsCloud } from '../../config/cloud'

const JOBS = join(import.meta.dir, '../../app/Jobs')
const ROOT = join(import.meta.dir, '../..')

/** The queue each job declares, out of the source rather than by importing it. */
function queuesJobsUse(): Map<string, string[]> {
  const found = new Map<string, string[]>()

  for (const file of readdirSync(JOBS).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(join(JOBS, file), 'utf8')
    const declared = /^\s*queue:\s*'([^']+)'/m.exec(source)

    // A job with no `queue` runs on `default`, which is the framework's own
    // fallback and is named in the list like any other.
    const queue = declared?.[1] ?? 'default'

    found.set(queue, [...(found.get(queue) ?? []), file.replace('.ts', '')])
  }

  return found
}

/** The commands this site keeps alive as queue workers. */
function workerCommands(): string[] {
  const site = (tsCloud as any)?.sites?.reviewos

  return ((site?.daemons ?? []) as Array<{ command?: string }>)
    .map(daemon => String(daemon?.command ?? ''))
    .filter(command => command.includes('queue:work'))
}

/**
 * The queues those workers name.
 *
 * A worker with no `--queue` covers everything: with the flag absent, the
 * processor reads the distinct queues out of the jobs table and works all of
 * them, re-reading every ten seconds. That is the shape this site uses, and it
 * is why `null` here means "all" rather than "none".
 */
function queuesWithWorkers(): string[] | null {
  const named: string[] = []

  for (const command of workerCommands()) {
    const flags = [...command.matchAll(/--queue[= ]([^\s]+)/g)].map(([, queue]) => queue)

    if (flags.length === 0)
      return null

    named.push(...flags)
  }

  return named
}

describe('the queue workers on the box', () => {
  test('are declared at all', () => {
    // The state this test was written for: none, while `scheduler: true`
    // enqueued work every five minutes that nothing could pick up.
    expect(workerCommands().length).toBeGreaterThan(0)
  })

  test('cover every queue a job actually uses', () => {
    const workers = queuesWithWorkers()

    // No `--queue` anywhere: every queue is covered by construction, including
    // ones added after this test was last read.
    if (workers === null)
      return

    const covered = new Set(workers)
    const uncovered: string[] = []

    for (const [queue, jobs] of queuesJobsUse()) {
      if (!covered.has(queue))
        uncovered.push(`${queue} (${jobs.sort().join(', ')})`)
    }

    // Named rather than counted: "2 queues are unworked" sends somebody to
    // diff two lists by hand, and the names say what stopped working.
    expect(uncovered.sort()).toEqual([])
  })

  test('name no queue that nothing dispatches to', () => {
    // A worker for a queue no job uses is a process doing nothing, and more
    // usefully it is a sign the queue was renamed and half the rename landed.
    const workers = queuesWithWorkers()

    if (workers === null)
      return

    const used = new Set(queuesJobsUse().keys())

    expect(workers.filter(queue => !used.has(queue)).sort()).toEqual([])
  })

  test('run a CLI that exists in this repository', () => {
    // The second failure, and the one that cost a week of mirrors: a unit whose
    // ExecStart named `storage/framework/core/buddy/src/cli.ts`, which this
    // layout does not have. The path is checked here rather than trusted,
    // because on the box the only evidence is a journal line every five
    // seconds in a unit nobody is looking at.
    const missing: string[] = []

    for (const command of workerCommands()) {
      const entry = /\bbun\s+(\S+\.(?:ts|js))\b/.exec(command)?.[1]

      if (!entry || !existsSync(join(ROOT, entry)))
        missing.push(command)
    }

    expect(missing).toEqual([])
  })
})

describe('the scheduler on the box', () => {
  test('is enabled, because nothing else fires the sweep', () => {
    // A worker processes what is enqueued. Without this, nothing enqueues -
    // and the symptom is an empty queue, which is what a healthy instance
    // looks like. See `app/Ops/health.ts`.
    expect((tsCloud as any)?.sites?.reviewos?.scheduler).toBe(true)
  })
})

/**
 * The instance's own address, in the environment of both processes.
 *
 * It was in neither. Both ran on whatever `.env` shipped - `reviewos.localhost`
 * - so everything derived from it was wrong in a way only somebody outside the
 * box could see: the clone box offered visitors a URL pointing at their own
 * machine, notification emails linked to a host that does not resolve, and a
 * passkey would have been registered against the wrong relying party. Nothing
 * about it is visible from inside, which is why it is asserted here.
 */
describe('the address the box answers at', () => {
  const sites = (tsCloud as any)?.sites ?? {}

  test('is in the environment of every server process', () => {
    for (const name of ['reviewos', 'api']) {
      const url = String(sites[name]?.env?.APP_URL ?? '')

      expect(url).toStartWith('https://')
      expect(url).toContain(String(sites[name]?.domain ?? 'reviewos.org'))
    }
  })

  test('and carries its scheme, because a consumer joins it to a path', () => {
    // `SendNotificationJob` builds `${APP_URL}${path}` directly, so a bare host
    // produces `reviewos.org/pulls/1`, which is not a link. Every consumer that
    // accepts a bare host accepts a full URL; the reverse is not true.
    for (const name of ['reviewos', 'api'])
      expect(() => new URL(String(sites[name]?.env?.APP_URL ?? ''))).not.toThrow()
  })

  test('and the two processes cannot disagree about it', () => {
    expect(sites.reviewos?.env?.APP_URL).toBe(sites.api?.env?.APP_URL)
  })
})
