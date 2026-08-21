/**
 * Who may take a job, and whose word about it counts.
 *
 * The decisions of the runner protocol, separated from the database so they can
 * be tested against the cases that matter - a duplicate claim, a late
 * completion, a credential used against the wrong job - none of which are
 * convenient to produce with a real runner, and all of which will happen.
 *
 * Every rule here starts from one assumption, which is [the threat
 * model's](../../../docs/ci-threat-model.md): **a runner is somebody else's
 * machine executing hostile code, and everything it says is untrusted input.**
 * It can lie about a result, replay an old credential, or come back from a
 * network partition believing it still holds work it lost ten minutes ago. None
 * of those may be able to change a run's answer.
 */

export interface RunnerFacts {
  id: number
  state: string
  scopeType: string
  /** Null when the scope is the whole instance. */
  scopeId: number | null
  /** What it says it can run, already split. */
  labels: readonly string[]
  /**
   * `key=value` facts the machine reported about itself, for `agents:`.
   *
   * Optional, and absent means "said nothing" rather than "has nothing" - the
   * difference matters only in that a machine which said nothing satisfies no
   * selector, which is the safe direction.
   */
  tags?: readonly string[]
}

export interface JobFacts {
  id: number
  state: string
  /** `runs-on`, already split. */
  runsOn: readonly string[]
  /** `reviewos.agents:`, a `key=value` query over a machine's tags. */
  agents?: readonly string[]
  /** Which repository's code this job would be handed. */
  repositoryId: number
  /** The repository's owner, for an organization-scoped runner. */
  ownerId: number
  /** Who holds it now, and until when. */
  runnerId: number | null
  leaseExpiresAt: string | null
}

/** One pattern per line, blank lines dropped. */
export function splitLabels(stored: string | null | undefined): string[] {
  return String(stored ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Whether a runner is allowed to see this repository's work at all.
 *
 * Checked before labels, because it is the one that matters: a runner
 * registered for one repository being handed another's source is not a
 * scheduling mistake, it is the instance giving somebody else's private code to
 * a machine its owner chose.
 */
export function runnerReaches(runner: RunnerFacts, job: JobFacts): boolean {
  switch (runner.scopeType) {
    case 'instance':
      return true
    case 'organization':
      return runner.scopeId !== null && runner.scopeId === job.ownerId
    case 'repository':
      return runner.scopeId !== null && runner.scopeId === job.repositoryId
    default:
      // An unknown scope reaches nothing. A scope this code does not
      // understand must not default to "everything" - that is the direction
      // that leaks, and a new scope added later would silently do it.
      return false
  }
}

/**
 * Whether a runner has what a job asks for.
 *
 * Every label, not any: `runs-on: [self-hosted, macos]` means both, and a
 * runner that has one of them is the wrong machine. Matching on "any" is how a
 * macOS build lands on a Linux box and fails with a confusing error rather than
 * waiting for the machine that could have run it.
 *
 * A job that asks for nothing runs anywhere, which is what an empty `runs-on`
 * means to somebody who wrote it.
 */
export function runnerSatisfies(runner: RunnerFacts, job: JobFacts): boolean {
  if (!satisfiesTags(runner, job))
    return false

  if (job.runsOn.length === 0)
    return true

  const has = new Set(runner.labels.map(label => label.toLowerCase()))

  return job.runsOn.every(label => has.has(label.toLowerCase()))
}

/**
 * Whether a machine's tags satisfy a job's `agents:` query.
 *
 * Labels are a set membership test, which is right for `ubuntu-latest` and
 * wrong for anything with a value in it: a fleet with four GPU models grows
 * labels called `gpu-a100`, and a label is whatever the person who typed it was
 * thinking. `agents: [gpu=a100]` says what it means.
 *
 * Every selector has to match, and a machine with no tags satisfies no
 * selector - which is the safe direction: a job that asked for a GPU waits
 * visibly rather than running on a machine that never said it had one.
 */
export function satisfiesTags(runner: RunnerFacts, job: JobFacts): boolean {
  const selectors = job.agents ?? []

  if (selectors.length === 0)
    return true

  const has = new Set((runner.tags ?? []).map(tag => tag.trim().toLowerCase()))

  return selectors.every(selector => has.has(selector.trim().toLowerCase()))
}

export interface ClaimDecision {
  ok: boolean
  /** Why not, in words a runner's log can carry and a person can read. */
  reason: string
}

/**
 * May this runner take this job, right now?
 *
 * `now` is passed rather than read, because a lease decision that depends on a
 * hidden clock cannot be tested at the boundary - and the boundary is the whole
 * question.
 */
export function mayClaim(runner: RunnerFacts, job: JobFacts, now: Date): ClaimDecision {
  if (runner.state !== 'active')
    return { ok: false, reason: 'this runner is disabled' }

  if (!runnerReaches(runner, job))
    return { ok: false, reason: 'this runner is not registered for that repository' }

  if (job.state === 'queued' && job.runnerId === null)
    return runnerSatisfies(runner, job)
      ? { ok: true, reason: 'queued and unheld' }
      : { ok: false, reason: `this runner does not have ${job.runsOn.join(', ')}` }

  /*
   * Held by somebody. The only way it becomes claimable again is the lease
   * lapsing - which is what makes a runner that died recoverable without a
   * person noticing, and what stops a duplicate claim while one is alive.
   */
  if (job.state === 'running' || job.runnerId !== null) {
    if (leaseIsLive(job, now))
      return { ok: false, reason: 'another runner holds this job' }

    return runnerSatisfies(runner, job)
      ? { ok: true, reason: 'the previous lease expired' }
      : { ok: false, reason: `this runner does not have ${job.runsOn.join(', ')}` }
  }

  return { ok: false, reason: `a job that is ${job.state} is not available` }
}

/** Whether the lease on a job has not yet lapsed. */
export function leaseIsLive(job: Pick<JobFacts, 'leaseExpiresAt'>, now: Date): boolean {
  if (!job.leaseExpiresAt)
    return false

  const expires = Date.parse(job.leaseExpiresAt)
  if (!Number.isFinite(expires))
    return false

  return expires > now.getTime()
}

export interface ReportDecision {
  ok: boolean
  reason: string
  /**
   * True when the report is a repeat of one already applied.
   *
   * Delivery is at-least-once, so a runner that did not hear the answer will
   * say it again. The second one is not an error and must not be treated as
   * one - it is answered as though it worked, because from the runner's side it
   * did.
   */
  duplicate: boolean
}

/**
 * Does this runner's word about this job count?
 *
 * The rule the whole protocol rests on: **only the lease holder, and only
 * before the lease lapses.** A worker that lost its connection and came back is
 * indistinguishable from one that never left, except by the lease - and without
 * this it can publish a success over a job that was cancelled and handed to
 * somebody else, which is a green check for work nobody did.
 */
export interface ReportOptions {
  /** What the runner says the job came to, when the caller knows. */
  reporting?: string
  terminalStates?: readonly string[]
}

export function mayReport(
  runner: RunnerFacts,
  job: JobFacts,
  now: Date,
  options: ReportOptions | readonly string[] = {},
): ReportDecision {
  // The fourth argument used to be the terminal-state list. Both forms are
  // accepted so a caller passing the old one keeps working rather than silently
  // handing an array where an options object is read - which would leave
  // `terminalStates` at its default and quietly change the rule.
  const settings: ReportOptions = Array.isArray(options) ? { terminalStates: options } : options as ReportOptions
  const terminalStates = settings.terminalStates ?? ['cancelled', 'failed', 'skipped', 'succeeded']

  if (job.runnerId === null)
    return { ok: false, reason: 'this job is not held by anybody', duplicate: false }

  if (job.runnerId !== runner.id) {
    // The credential-against-the-wrong-job case. Not "not found", because the
    // runner is real: it is holding something, just not this.
    return { ok: false, reason: 'this job is held by another runner', duplicate: false }
  }

  if (terminalStates.includes(job.state)) {
    // Already finished, by this runner. At-least-once delivery means it will
    // be said twice, and the second time is a repeat rather than a conflict.
    return { ok: true, reason: 'already recorded', duplicate: true }
  }

  /*
   * Acknowledging a cancellation, with a lease that was deliberately revoked.
   *
   * Cancelling a run expires every lease it holds *at the moment of the
   * request*, which is what stops a worker that already lost its connection
   * publishing a success over a run somebody stopped. The side effect was that
   * a well-behaved runner - one that heard the cancellation, stopped its work
   * and came back to say so - was refused for the same reason as the bad one,
   * and its job sat in `cancelling` until a sweep forced it.
   *
   * So one report survives a revoked lease, and only one: `cancelled`. The
   * credential still proves this is the holder, and "I stopped" cannot
   * fabricate a verdict the way "I succeeded" can. Anything else from an
   * expired lease is refused exactly as before.
   */
  if (job.state === 'cancelling' && settings.reporting === 'cancelled')
    return { ok: true, reason: 'acknowledging a cancellation', duplicate: false }

  if (!leaseIsLive(job, now))
    return { ok: false, reason: 'this lease has expired', duplicate: false }

  return { ok: true, reason: 'the lease holder, in time', duplicate: false }
}

/** How long a lease lasts before a runner has to say it is still alive. */
export const LEASE_SECONDS = 60

/**
 * When a lease taken or renewed now would lapse.
 *
 * Short, and renewed by heartbeat rather than long. A long lease means a job
 * held by a machine that died is stuck for as long as the lease - and the whole
 * reason for the recovery sweep is that the machine cannot be asked.
 */
export function leaseUntil(now: Date, seconds = LEASE_SECONDS): string {
  return new Date(now.getTime() + seconds * 1000).toISOString()
}

/**
 * The wire contract's version, and what this server will speak.
 *
 * A self-hosted runner is a program somebody else installs, on a machine
 * somebody else reboots, upgraded on a schedule nobody here controls. So the
 * two ends drift apart by default, and the question is only whether they find
 * out by being told or by behaving strangely - a runner sending a field this
 * server ignores, or reading one it stopped sending, produces a job that hangs
 * rather than an error anybody can act on.
 *
 * One number, deliberately, rather than per-endpoint versions or feature flags.
 * A fleet operator upgrading a hundred machines needs one thing to compare, and
 * a matrix of capabilities is a matrix of states nobody tests.
 *
 * **A range rather than a number**, because both directions have to work during
 * an upgrade: a fleet is never upgraded atomically, so the server has to keep
 * speaking to the machines nobody has restarted yet, and a runner upgraded
 * ahead of its server must be told rather than left guessing.
 */
export const RUNNER_PROTOCOL = {
  /** The oldest a runner may speak. Raising this retires a runner version. */
  minimum: 1,
  /** The newest this server knows. Raising it is how a new field ships. */
  current: 1,
} as const

/** The header a runner sends, and the one this server answers with. */
export const PROTOCOL_HEADER = 'X-Runner-Protocol'
export const PROTOCOL_SUPPORTED_HEADER = 'X-Runner-Protocol-Supported'

export interface ProtocolDecision {
  ok: boolean
  /** What the runner is speaking, as this server understood it. */
  version: number
  /** Said to the runner when it is refused. Never to a person. */
  reason: string
}

/**
 * Whether this server and this runner speak the same protocol.
 *
 * **A missing version is the oldest one**, not a refusal. Every runner written
 * before this existed sends nothing, and answering those with an error would
 * break every fleet on the day the header shipped - which is the opposite of
 * what a compatibility check is for. They are told what to send in the response
 * header, and they keep working until `minimum` moves past them.
 *
 * A version this server does not recognise is refused in both directions. Too
 * old means the runner is sending a shape this server has stopped reading; too
 * new means it is sending one this server has not learned. Guessing at either
 * is how a job hangs instead of failing.
 */
export function negotiate(
  sent: unknown,
  // Takes the range rather than reading the constant, so the retirement path
  // can be tested before there is a retired version - and so a server that
  // wants to pin an older range has somewhere to say it.
  supported: { minimum: number, current: number } = RUNNER_PROTOCOL,
): ProtocolDecision {
  const raw = String(sent ?? '').trim()

  if (!raw)
    return { ok: true, version: supported.minimum, reason: 'no version sent, assumed the oldest' }

  const version = Number(raw)

  if (!Number.isInteger(version) || version <= 0) {
    return {
      ok: false,
      version: 0,
      reason: `${PROTOCOL_HEADER} must be a whole number. This server speaks ${describeProtocol(supported)}.`,
    }
  }

  if (version < supported.minimum) {
    return {
      ok: false,
      version,
      reason: `This runner speaks protocol ${version}, which this server has retired. It speaks ${describeProtocol(supported)}; upgrade the runner.`,
    }
  }

  if (version > supported.current) {
    return {
      ok: false,
      version,
      reason: `This runner speaks protocol ${version}, which this server does not know yet. It speaks ${describeProtocol(supported)}; upgrade the server or run an older runner.`,
    }
  }

  return { ok: true, version, reason: 'agreed' }
}

/** `1` when there is one version, `1 to 3` when there are several. */
export function describeProtocol(supported: { minimum: number, current: number } = RUNNER_PROTOCOL): string {
  return supported.minimum === supported.current
    ? String(supported.current)
    : `${supported.minimum} to ${supported.current}`
}

/**
 * The header every runner response carries.
 *
 * On the successful answers too, not only the refusals. A runner that is about
 * to be retired should be able to find that out from an ordinary poll rather
 * than from the first request that fails, and an operator diagnosing a fleet
 * should be able to read both ends' opinion out of one response.
 */
export function protocolHeaders(): Record<string, string> {
  return { [PROTOCOL_SUPPORTED_HEADER]: describeProtocol() }
}
