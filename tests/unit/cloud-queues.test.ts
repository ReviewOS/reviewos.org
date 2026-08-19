// Every queue a job uses has a worker on the box.
//
// This is the test for the failure that took the mirrors down, and the reason
// it is worth a test is that the failure is *invisible*. ts-cloud writes one
// systemd unit per entry in `sites.reviewos.queues`, each running
// `queue:work --queue=<name>`, and a queue with no entry is simply never
// worked: nothing errors, no log line is written, the queue depth for that name
// climbs, and the feature behind it stops happening.
//
// It had no entries at all. `scheduler: true` was set, so `MirrorSweep` was
// enqueued on the `mirrors` queue every five minutes exactly as intended - and
// nothing ever ran it, so no `MirrorSyncJob` was ever created and every mirror
// on the instance froze with a clean record. The same silence covered
// notifications, webhooks, outbound email, and the language and contributor
// measures.
//
// So the list in `config/cloud.ts` - `tsCloud.sites.reviewos.queues`, which is
// the export ts-cloud reads, not the `CloudConfig` default export beside it -
// is checked against the jobs rather than trusted, and a new job on a new queue
// fails here until somebody adds a worker for it.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tsCloud } from '../../config/cloud'

const JOBS = join(import.meta.dir, '../../app/Jobs')

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

/** The queues a worker is declared for. */
function queuesWithWorkers(): string[] {
  const site = (tsCloud as any)?.sites?.reviewos

  return ((site?.queues ?? []) as Array<{ queue?: string }>)
    .map(worker => String(worker?.queue ?? 'default'))
}

describe('the queue workers on the box', () => {
  test('are declared at all', () => {
    // The state this test was written for: none, while `scheduler: true`
    // enqueued work every five minutes that nothing could pick up.
    expect(queuesWithWorkers().length).toBeGreaterThan(0)
  })

  test('cover every queue a job actually uses', () => {
    const workers = new Set(queuesWithWorkers())
    const uncovered: string[] = []

    for (const [queue, jobs] of queuesJobsUse()) {
      if (!workers.has(queue))
        uncovered.push(`${queue} (${jobs.sort().join(', ')})`)
    }

    // Named rather than counted: "2 queues are unworked" sends somebody to
    // diff two lists by hand, and the names say what stopped working.
    expect(uncovered.sort()).toEqual([])
  })

  test('name no queue that nothing dispatches to', () => {
    // A worker for a queue no job uses is a process doing nothing, and more
    // usefully it is a sign the queue was renamed and half the rename landed.
    const used = new Set(queuesJobsUse().keys())
    const idle = queuesWithWorkers().filter(queue => !used.has(queue))

    expect(idle.sort()).toEqual([])
  })

  test('declare each queue once', () => {
    // Two entries for one queue is two processes competing for the same rows,
    // which is legitimate - but only when it is `processes`, said out loud.
    const declared = queuesWithWorkers()

    expect(declared.length).toBe(new Set(declared).size)
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
