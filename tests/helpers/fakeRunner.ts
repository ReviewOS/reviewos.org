/**
 * A runner that claims work and reports results without executing anything.
 *
 * The point is what it does *not* do: it has no state machine of its own. It
 * calls `claimNextJob` and `reportJob` - the same two functions the runner
 * endpoints wrap - so every transition it produces is the one production would
 * produce. A harness that decided for itself what a failed job does to a run
 * would agree with the real thing until the day the real thing changed, and
 * then it would be a test suite defending the old behaviour.
 *
 * What it is for: driving a whole pipeline to its conclusion in a test, and
 * asserting the shape of what happened. A graph with a barrier, a gate, a
 * fan-out and a fail-fast is four features interacting, and the interaction is
 * where the bugs are - but writing it by hand means twenty `updateTable` calls
 * that quietly bypass exactly the rules under test.
 *
 * It stops when nothing is claimable, which is a meaningful state rather than
 * an end condition: a run holding at a gate, or waiting for an event, has no
 * claimable job and is not finished. A test asserts that difference instead of
 * timing out.
 */

import { claimNextJob } from '../../app/Actions/Runner/claim'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import type { RunnerFacts } from '../../app/Actions/Runner/protocol'
import { reportJob } from '../../app/Actions/Runner/report'

/** What the fake runner should say about a job when it claims one. */
export interface FakeOutcome {
  state?: 'succeeded' | 'failed' | 'cancelled'
  outputs?: Record<string, string>
  error?: string
  /** The exit status, for a workflow whose `retry:` names one. */
  exitStatus?: number | null
}

/** One thing the harness did, in the order it did it. */
export interface FakeStep {
  jobKey: string
  jobId: number
  reported: string
}

export interface FakeRunner {
  facts: RunnerFacts
  runnerId: number
  /**
   * Claim and report until nothing is claimable.
   *
   * `outcomes` is keyed on the job's `job_id` - the name `needs:` refers to -
   * and anything not named succeeds, because a test about a failure is a test
   * about one failure.
   */
  drain: (outcomes?: Record<string, FakeOutcome>, limit?: number) => Promise<FakeStep[]>
  remove: () => Promise<void>
}

/**
 * Register a machine that takes work and answers instantly.
 *
 * Instance-scoped with the labels the test names, because a harness that could
 * only take work from one repository would be a harness that cannot test the
 * scope rules it is standing in for.
 */
export async function fakeRunner(options: {
  db: any
  labels?: readonly string[]
  name?: string
}): Promise<FakeRunner> {
  const db = options.db
  const labels = [...(options.labels ?? ['ubuntu-latest'])]
  const token = `fake-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

  const row: any = await db
    .insertInto('runners')
    .values({
      name: options.name ?? `fake-${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex')}`,
      scope_type: 'instance',
      scope_id: null,
      token_hash: hashToken(token),
      labels: labels.join('\n'),
      state: 'active',
    })
    .returning(['id'])
    .executeTakeFirst()

  const runnerId = Number(row.id)

  const facts: RunnerFacts = {
    id: runnerId,
    state: 'active',
    scopeType: 'instance',
    scopeId: null,
    labels,
  }

  return {
    facts,
    runnerId,

    async drain(outcomes = {}, limit = 200) {
      const done: FakeStep[] = []

      for (let taken = 0; taken < limit; taken++) {
        const claimed = await claimNextJob(facts)

        /*
         * Nothing claimable. Not necessarily finished - a run holding at a gate
         * or waiting for an event has no claimable job either, and a caller
         * that treats this as "the run ended" is a caller that will assert the
         * wrong thing about the most interesting graphs.
         */
        if (!claimed)
          break

        const asked = outcomes[String(claimed.jobKey)] ?? {}
        const state = asked.state ?? 'succeeded'

        await reportJob(facts, {
          jobId: claimed.jobId,
          state,
          error: asked.error ?? null,
          outputs: asked.outputs ?? null,
          exitStatus: asked.exitStatus ?? null,
        })

        done.push({ jobKey: String(claimed.jobKey), jobId: Number(claimed.jobId), reported: state })
      }

      return done
    },

    async remove() {
      await db.deleteFrom('runners').where('id', '=', runnerId).execute().catch(() => null)
    },
  }
}
