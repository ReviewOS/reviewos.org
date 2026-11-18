import { expect, test } from 'bun:test'
import { RunnerLease } from '../../app/Actions/Runner/lease'

test('an expired lease reports timer delay without extending ownership after a blocked event loop', async () => {
  const failures: any[] = []
  const lease = new RunnerLease(20, details => failures.push(details))
  try {
    Bun.sleepSync(80)
    await Bun.sleep(5)
    expect(lease.signal.aborted).toBe(true)
    expect((lease.signal.reason as Error).message).toBe('The instance did not renew this job before its lease expired')
    expect(failures).toHaveLength(1)
    expect(failures[0].timerLateMs).toBeGreaterThanOrEqual(40)
    expect(failures[0].leaseDurationMs).toBe(20)
    lease.renew()
    await Bun.sleep(30)
    expect(failures).toHaveLength(1)
    expect(lease.signal.aborted).toBe(true)
  }
  finally { lease.dispose() }
})

test('expiry identifies the preparation phase and an unanswered heartbeat without exposing credentials', async () => {
  const failures: any[] = []
  const lease = new RunnerLease(20, details => failures.push(details))
  try {
    lease.setPhase('toolchain')
    lease.heartbeatStarted()
    lease.heartbeatFinished(false, 503)
    lease.heartbeatStarted()
    await Bun.sleep(40)
    expect(lease.signal.aborted).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toEqual(expect.objectContaining({
      phase: 'toolchain', heartbeatsStarted: 2, heartbeatsAnswered: 1,
      inFlightHeartbeats: 1, lastHeartbeatStatus: 503, lastSuccessfulHeartbeatAgoMs: null,
    }))
    expect(failures[0].lastHeartbeatStartedAgoMs).toBeGreaterThanOrEqual(15)
    expect(failures[0].lastHeartbeatAnsweredAgoMs).toBeGreaterThanOrEqual(15)
    expect(Object.values(failures[0]).every(value => value === null || typeof value === 'number' || value === 'toolchain')).toBe(true)
  }
  finally { lease.dispose() }
})

test('a broken diagnostic sink cannot keep a lease alive', async () => {
  const lease = new RunnerLease(10, () => { throw new Error('diagnostic sink unavailable') })
  try {
    await Bun.sleep(30)
    expect(lease.signal.aborted).toBe(true)
  }
  finally { lease.dispose() }
})
