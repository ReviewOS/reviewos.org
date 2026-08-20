import { Job } from '@stacksjs/queue'
import { wakeSleepingRuns } from '../Actions/Workflow/wake'

/**
 * The clock that ends a sleep.
 *
 * A suspended run holds nothing - no lease, no machine, no process - which is
 * the entire point of suspending it and also the reason this exists. Nothing is
 * watching a run that holds nothing, so without a sweep a workflow that asked
 * to wait an hour waits forever.
 *
 * Every minute, because a minute is the resolution the rest of the scheduler
 * already works at and a sleep is not a timer somebody sets for three seconds.
 * A workflow that needs sub-minute precision is describing a `sleep` inside a
 * step, not a suspension.
 *
 * The sweep only requeues. Whether the sleep is *over* is decided in the
 * journal, where every other decision about the journal is made - a second
 * place deciding it would eventually disagree with the first.
 */
export default new Job({
  name: 'WakeSleepingRunsJob',
  description: 'Put an orchestrator back in the queue when its sleep is due',
  tries: 1,
  backoff: 3,

  async handle() {
    const { woken, due } = await wakeSleepingRuns()

    return { ok: true, woken, due }
  },
})
