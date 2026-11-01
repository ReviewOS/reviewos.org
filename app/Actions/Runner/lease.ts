import { LEASE_SECONDS } from './protocol'

/**
 * How much sooner than the instance this machine gives up a lease.
 *
 * The instance sets a lease's expiry when it answers a heartbeat, and this
 * machine starts its own clock when that answer arrives - later, by however
 * long the answer took. A local clock as long as the instance's therefore ran
 * out *after* the instance's, and for that gap the instance could hand the job
 * to another machine while this one was still running it. Giving up twenty
 * seconds early leaves the job's processes time to stop before anybody else
 * can be given the work (and the instance waits a further
 * `RECLAIM_GRACE_SECONDS` before it does).
 */
export const LOCAL_LEASE_MARGIN_SECONDS = 20

/** The local lease: the instance's, less the margin above. */
export const LOCAL_LEASE_MS = (LEASE_SECONDS - LOCAL_LEASE_MARGIN_SECONDS) * 1000

/**
 * How often a running job says "still here".
 *
 * Four beats per local lease, so one lost heartbeat - a deploy restarting the
 * instance's gateway, a dropped connection - costs nothing, and only a
 * controller that stays unreachable for most of the lease takes the job away.
 */
export const HEARTBEAT_MS = Math.max(5000, LOCAL_LEASE_MS / 4)

/** Why a job ended when the runner itself was asked to stop. */
export class RunnerStopped extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'RunnerStopped'
  }
}

/** A job may execute only while the instance still renews its lease. */
export class RunnerLease {
  private readonly controller = new AbortController()
  private expiry: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private stopped = false

  constructor(private readonly durationMs = LOCAL_LEASE_MS) {
    this.renew()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /**
   * Whether the job was given up because this runner is stopping.
   *
   * Different from a lapsed or revoked lease: nobody decided anything about
   * the work, so it must not be reported as cancelled or failed. The instance
   * returns it to the queue once its lease lapses.
   */
  get abandoned(): boolean {
    return this.stopped
  }

  renew(): void {
    if (this.closed || this.signal.aborted) return
    clearTimeout(this.expiry)
    this.expiry = setTimeout(() => {
      this.controller.abort(new Error('The instance did not renew this job before its lease expired'))
    }, this.durationMs)
  }

  refuse(status: number | undefined, reason: string): void {
    if (this.closed) return
    // Transport failures and throttling can recover within the existing lease.
    // An authoritative refusal means this machine no longer owns the work.
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      this.dispose()
      this.controller.abort(new Error(`The instance revoked this job's lease: ${reason}`))
    }
  }

  /** Stop the job because the runner is stopping, not because of anything the job did. */
  abandon(reason: string): void {
    if (this.signal.aborted) return
    this.stopped = true
    this.dispose()
    this.controller.abort(new RunnerStopped(reason))
  }

  dispose(): void {
    this.closed = true
    clearTimeout(this.expiry)
    this.expiry = undefined
  }
}
