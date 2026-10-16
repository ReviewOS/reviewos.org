import { LEASE_SECONDS } from './protocol'

/** A job may execute only while the instance still renews its lease. */
export class RunnerLease {
  private readonly controller = new AbortController()
  private expiry: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(private readonly durationMs = LEASE_SECONDS * 1000) {
    this.renew()
  }

  get signal(): AbortSignal {
    return this.controller.signal
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

  dispose(): void {
    this.closed = true
    clearTimeout(this.expiry)
    this.expiry = undefined
  }
}
