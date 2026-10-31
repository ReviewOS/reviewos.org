// Why a queued job is still queued.
//
// A run sitting at "queued" with a spinner is the most expensive screen in a
// forge: it looks like the instance is thinking, so people wait, then wait
// longer, then ask in a chat channel. The instance knew the answer the whole
// time.

import { describe, expect, test } from 'bun:test'
import { explainWaiting } from '../../app/Actions/Workflow/waiting'

const job = {
  id: 1,
  state: 'queued',
  runsOn: ['ubuntu-latest'],
  repositoryId: 7,
  ownerId: 3,
  runnerId: null,
  leaseExpiresAt: null,
}

function runner(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    state: 'active',
    scopeType: 'instance',
    scopeId: null,
    labels: ['ubuntu-latest', 'self-hosted'],
    ...overrides,
  }
}

describe('explaining a queued job', () => {
  test('no runners at all is the first thing to say', () => {
    const answer = explainWaiting(job, [])

    expect(answer.kind).toBe('no-runners')
    expect(answer.summary).toContain('No runners are registered')
  })

  test('a runner that cannot see this repository is not an answer to it', () => {
    // Scope before labels: a runner registered for one repository being told
    // about another's work is not a scheduling detail, it is the wrong runner.
    const answer = explainWaiting(job, [runner({ scopeType: 'repository', scopeId: 999 })])

    expect(answer.kind).toBe('none-reach')
  })

  /*
   * The box this implements. "No runner has `macos-14`" is half an answer; the
   * other half is what the runners that *could* take it actually have, which is
   * what tells somebody what to write instead.
   */
  test('labels that do not match name both sides', () => {
    const answer = explainWaiting({ ...job, runsOn: ['macos-14'] }, [runner()])

    expect(answer.kind).toBe('no-labels')
    expect(answer.summary).toContain('`macos-14`')
    expect(answer.summary).toContain('`ubuntu-latest`')
    expect(answer.available).toEqual(['self-hosted', 'ubuntu-latest'])
  })

  test('and the available labels are collected across every runner that reaches it', () => {
    const answer = explainWaiting({ ...job, runsOn: ['windows'] }, [
      runner({ id: 1, labels: ['ubuntu-latest'] }),
      runner({ id: 2, labels: ['macos-14', 'arm64'] }),
    ])

    expect(answer.available).toEqual(['arm64', 'macos-14', 'ubuntu-latest'])
  })

  /*
   * A different problem from having no runner with the right labels, and the
   * difference is the difference between "turn that runner back on" and
   * "change your `runs-on`".
   */
  test('a matching runner that is switched off says so', () => {
    const answer = explainWaiting(job, [runner({ state: 'disabled' })])

    expect(answer.kind).toBe('all-disabled')
    expect(answer.summary).toContain('disabled')
  })

  test('one of two disabled is not a problem at all', () => {
    const answer = explainWaiting(job, [runner({ id: 1, state: 'disabled' }), runner({ id: 2 })])

    expect(answer.kind).toBe('ready')
  })

  /*
   * `ready` is a real answer rather than an absence: a job a runner can take is
   * about to be taken, and "waiting for a runner to poll" is honest where
   * "queued" is not.
   */
  test('a job that can be taken says it is about to be', () => {
    const answer = explainWaiting(job, [runner()])

    expect(answer.kind).toBe('ready')
    expect(answer.summary).toContain('next poll')
  })

  /*
   * The dispatcher's rule, not this screen's: a job asking for nothing runs
   * anywhere, which is what an empty `runs-on` means to whoever wrote it. This
   * test exists because the obvious explanation - "it names no labels, so
   * nothing matches" - is the opposite of what the dispatcher does, and a
   * screen that explains a decision nobody made is worse than a spinner.
   */
  test('a job with no runs-on runs anywhere, the way the dispatcher reads it', () => {
    const answer = explainWaiting({ ...job, runsOn: [] }, [runner()])

    expect(answer.kind).toBe('ready')
  })

  test('an organization-scoped runner reaches its own owner\'s repositories', () => {
    const answer = explainWaiting(job, [runner({ scopeType: 'organization', scopeId: 3 })])

    expect(answer.kind).toBe('ready')
  })
})

/*
 * The remedy, not just the diagnosis.
 *
 * A new instance lands on `no-runners` every single time, and it is the one
 * moment where the whole feature looks broken rather than unconfigured. The
 * page shows this only to somebody who can act on it - a shell command in front
 * of every visitor is noise - which is why it is a separate field rather than
 * more sentences in the summary.
 */
describe('what to do about it', () => {
  test('an instance with no runners is told the command that fixes it', () => {
    const explanation = explainWaiting(job, [])

    expect(explanation.kind).toBe('no-runners')
    expect(explanation.fix).toContain('buddy runner:local')
  })

  test('a label mismatch names both ways out of it', () => {
    const explanation = explainWaiting({ ...job, runsOn: ['macos-14'] }, [runner({ labels: ['ubuntu-latest'] })])

    expect(explanation.kind).toBe('no-labels')
    expect(explanation.fix).toContain('runs-on')
    expect(explanation.fix).toContain('macos-14')
  })

  test('and a job that is about to run is offered no advice at all', () => {
    // Inventing something to say here would teach people to skim the line that
    // matters.
    expect(explainWaiting(job, [runner({ labels: ['ubuntu-latest'] })]).fix).toBe('')
  })
})

/*
 * A runner that polls and refuses work.
 *
 * On 2026-10-31 HQ's Mac runner held itself for want of disk from 22:04 until
 * morning, and the jobs for it sat at "queued" with this page saying a runner
 * "will take it on its next poll". The machine's reason was only in its own
 * log. These are the answers the run page and the run API now give.
 */
describe('a runner that is up but refusing work', () => {
  const now = new Date('2026-10-31T09:00:00.000Z')
  const mac = { ...job, runsOn: ['self-hosted', 'macos-arm64', 'hq-mobile'] }
  const reason = 'Insufficient workspace disk space at /Users/ci/work: 9355 MiB available, 24576 MiB required'

  function machine(overrides: Record<string, unknown> = {}): any {
    return runner({
      id: 2,
      name: 'hq-macos-arm64',
      labels: ['self-hosted', 'macos-arm64', 'hq-mobile'],
      lastSeenAt: '2026-10-31T08:59:55.000Z',
      holdReason: null,
      holdStartedAt: null,
      ...overrides,
    })
  }

  test('names the machine and gives its reason when every match is holding', () => {
    const answer = explainWaiting(mac, [machine({ holdReason: reason, holdStartedAt: '2026-10-30T22:04:00.000Z' })], now)

    expect(answer.kind).toBe('holding')
    expect(answer.summary).toBe(`Waiting: hq-macos-arm64 is holding since 2026-10-30 22:04 UTC (11 hours): ${reason}.`)
    expect(answer.fix).toContain('next poll')
  })

  test('one machine holding while another takes work is still ready', () => {
    const answer = explainWaiting(mac, [machine({ holdReason: reason }), machine({ id: 3, name: 'mac-2' })], now)

    expect(answer.kind).toBe('ready')
    expect(answer.summary).toContain('A runner matches')
  })

  test('a machine that stopped polling is offline, whatever it last said', () => {
    // A stale hold on a machine that is gone would send somebody to clean a
    // disk that is not the problem.
    const answer = explainWaiting(mac, [machine({ holdReason: reason, lastSeenAt: '2026-10-30T21:00:00.000Z' })], now)

    expect(answer.kind).toBe('offline')
    expect(answer.summary).toBe('Waiting: hq-macos-arm64 is offline: last seen 2026-10-30 21:00 UTC (12 hours ago).')
    expect(answer.summary).not.toContain('disk')
  })

  test('a machine that never polled says so', () => {
    const answer = explainWaiting(mac, [machine({ lastSeenAt: null })], now)

    expect(answer.kind).toBe('offline')
    expect(answer.summary).toContain('has never polled')
  })

  test('holding and offline together name both machines', () => {
    const answer = explainWaiting(mac, [
      machine({ holdReason: reason }),
      machine({ id: 3, name: 'mac-2', lastSeenAt: '2026-10-31T08:00:00.000Z' }),
    ], now)

    expect(answer.kind).toBe('holding')
    expect(answer.summary).toContain('hq-macos-arm64 is holding: Insufficient workspace disk space')
    expect(answer.summary).toContain('mac-2 is offline: last seen 2026-10-31 08:00 UTC (60 minutes ago)')
  })

  test('a caller that does not report liveness keeps its old answer', () => {
    expect(explainWaiting(job, [runner()], now).kind).toBe('ready')
  })

  test('a disabled machine is still explained as disabled, not holding', () => {
    expect(explainWaiting(mac, [machine({ state: 'disabled', holdReason: reason })], now).kind).toBe('all-disabled')
  })
})
