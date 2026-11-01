import process from 'node:process'
import { LEASE_SECONDS } from './protocol'

/**
 * How long the runner keeps trying to hand something to an instance that is
 * not answering, before it gives up.
 *
 * A deploy restarts the instance's gateway, and for those few seconds every
 * request is refused. Five quick retries rode out about three seconds of that,
 * so a step whose output met a five-second restart was stopped and its job
 * failed (HQ job 7010, 2026-11-01, "The step output could not be delivered").
 * A minute, the length of a lease: while a job is running its lease is the
 * real bound - an instance that stays away longer takes the job back anyway.
 * `REVIEWOS_RUNNER_DELIVERY_DEADLINE_MS` overrides it.
 */
export function deliveryDeadlineMs(): number {
  const configured = Number(process.env.REVIEWOS_RUNNER_DELIVERY_DEADLINE_MS)

  return Number.isFinite(configured) && configured > 0 ? configured : LEASE_SECONDS * 1000
}
