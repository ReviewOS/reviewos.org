/**
 * Why a queued job is still queued.
 *
 * A run that sits at "queued" with a spinner is the most expensive screen in a
 * forge: it looks like the instance is thinking, so people wait, and then they
 * wait longer, and eventually somebody asks in a chat channel. The instance
 * knows the answer the whole time - there is no runner with `macos-14`, or no
 * runner at all, or the only one that matches was switched off this morning.
 *
 * This is that answer, computed rather than guessed, from the same rules
 * [the claim protocol](../Runner/protocol.ts) uses to hand work out. Anything
 * else would eventually disagree with it, and a screen that explains a decision
 * the dispatcher did not make is worse than a spinner.
 */

import type { QueueFacts } from '../Runner/fleet'
import { queueAccepts, SILENT_SECONDS } from '../Runner/fleet'
import type { JobFacts, RunnerFacts } from '../Runner/protocol'
import { runnerReaches, runnerSatisfies, satisfiesTags } from '../Runner/protocol'

export type WaitingKind =
  | 'ready'
  | 'no-runners'
  | 'none-reach'
  | 'no-labels'
  | 'all-busy'
  | 'all-disabled'
  /** Every matching runner is in a queue somebody drained. */
  | 'queue-paused'
  /** Every matching runner is in a pool that does not serve this repository. */
  | 'pool-refuses'
  /** No machine reported the tags this job's `agents:` query asks for. */
  | 'no-tags'
  /** Every matching runner is up and refusing work, and said why. */
  | 'holding'
  /** Every matching runner has stopped polling, or never started. */
  | 'offline'

export interface WaitingExplanation {
  kind: WaitingKind
  /** One sentence, for the screen. */
  summary: string
  /**
   * What to do about it, for a reader who can.
   *
   * Separate from the summary because the audiences are different: everybody
   * looking at a stuck run deserves to know *why*, and only somebody who
   * administers the instance can act on "run this command". A page that shows
   * a shell command to every visitor is noise; one that shows nobody is a
   * paragraph that stops one word short of useful.
   */
  fix: string
  /** What the job asked for. */
  wanted: string[]
  /**
   * Labels that would have matched, from the runners that can see this
   * repository.
   *
   * The whole point of the box this implements: "no runner has `macos-14`" is
   * half an answer, and "the runners that could take this have `ubuntu-latest`,
   * `self-hosted`" is the other half - the one that tells somebody what to
   * write instead.
   */
  available: string[]
}

/**
 * Explain one queued job.
 *
 * `ready` is a real answer, not an absence: a job that a runner can take is one
 * that is about to be taken, and saying "waiting for a runner to poll" is
 * honest where "queued" is not.
 */
/**
 * A runner, and the queue it serves when it serves one.
 *
 * The screen has to know about queues because the dispatcher does: a job that
 * every machine refuses because somebody drained a queue looks identical, from
 * the outside, to a job nothing has labels for - and the two have opposite
 * remedies.
 */
export interface FleetRunner extends RunnerFacts {
  queue?: QueueFacts | null
  /** What a person calls it, for a sentence that names the machine. */
  name?: string
  /**
   * When it last polled. `null` is "never"; absent is "the caller did not
   * say", which is treated as recently - so a caller that has not been taught
   * about liveness keeps the answers it always gave.
   */
  lastSeenAt?: string | null
  /** Why it is refusing work, in its own words, while it is. */
  holdReason?: string | null
  /** When the current hold began. */
  holdStartedAt?: string | null
}

export function explainWaiting(job: JobFacts, runners: readonly FleetRunner[], now: Date = new Date()): WaitingExplanation {
  const wanted = [...job.runsOn]

  if (runners.length === 0) {
    return {
      kind: 'no-runners',
      summary: 'No runners are registered on this instance, so nothing can pick this job up.',
      // The first run of a new instance lands here, every time, and it is the
      // one moment where the whole feature looks broken rather than unconfigured.
      fix: 'On the machine this instance runs on: `./buddy runner:local`. It registers a runner for this host, answers to `ubuntu-latest`, and starts taking jobs. Steps run with no isolation, which is right for one team on one box and wrong for anything else.',
      wanted,
      available: [],
    }
  }

  const reaching = runners.filter(runner => runnerReaches(runner, job))

  if (reaching.length === 0) {
    return {
      kind: 'none-reach',
      summary: 'No runner is registered for this repository, or for an owner or instance that includes it.',
      fix: 'Register a runner scoped to this repository, its owner, or the whole instance.',
      wanted,
      available: [],
    }
  }

  /*
   * Labels are checked against every runner that reaches the repository,
   * including the ones that are switched off.
   *
   * A disabled runner with the right labels is a different problem from no
   * runner with the right labels, and telling them apart is the difference
   * between "turn that runner back on" and "change your `runs-on`".
   */
  const matching = reaching.filter(runner => runnerSatisfies(runner, job))
  const available = [...new Set(reaching.flatMap(runner => runner.labels))].sort()

  /*
   * An `agents:` query nothing satisfies, told apart from a label mismatch.
   *
   * The two look identical from the outside and have different remedies: a
   * label is changed in the workflow, and a tag is set on the machine at
   * startup by whatever knows it has a GPU. A selector nobody matches would
   * otherwise leave a job queued forever with a message about labels that are
   * perfectly fine.
   */
  const selectors = job.agents ?? []

  if (selectors.length > 0 && reaching.filter(runner => satisfiesTags(runner, job)).length === 0) {
    const reported = [...new Set(reaching.flatMap(runner => runner.tags ?? []))].sort()

    return {
      kind: 'no-tags',
      summary: `No runner here reports ${list([...selectors])}. ${reported.length > 0 ? `The runners that could take this job report ${list(reported)}.` : 'None of them report any tags at all.'}`,
      fix: 'Set the tag on the machine at startup, or change this job\'s `agents:` query.',
      wanted: [...selectors],
      available: reported,
    }
  }

  if (matching.length === 0) {
    /*
     * `wanted` is never empty here, and that is the dispatcher's rule rather
     * than an assumption: a job asking for nothing runs anywhere, so it is
     * always matched and never reaches this branch. Writing a message for the
     * empty case would be this screen explaining a decision the dispatcher does
     * not make, which is worse than no explanation at all.
     */
    return {
      kind: 'no-labels',
      summary: `No runner here has ${list(wanted)}. The runners that could take this job have ${list(available)}.`,
      fix: `Change this job's \`runs-on:\` to a label a runner has, or give a runner ${list(wanted)}.`,
      wanted,
      available,
    }
  }

  /*
   * The fleet rules, before the enabled check.
   *
   * A drained queue and a pool that refuses this repository are both "the
   * machines exist and will not take it", which is a different sentence from
   * "the machines are switched off" and a different thing to do about it.
   * Asked of the same function the claim uses, so the screen cannot explain a
   * decision the dispatcher did not make.
   */
  const admitted = matching.filter(runner => queueAccepts(runner.queue ?? null, job.repositoryId).ok)

  if (matching.length > 0 && admitted.length === 0) {
    const refusal = matching
      .map(runner => queueAccepts(runner.queue ?? null, job.repositoryId))
      .find(verdict => !verdict.ok)

    if (refusal && !refusal.ok) {
      return {
        kind: refusal.kind,
        summary: refusal.reason,
        fix: refusal.kind === 'queue-paused'
          ? 'Resume the queue when the machines are back, or register a runner in another one.'
          : 'Add this repository to that pool, or give it a pool of its own.',
        wanted,
        available,
      }
    }
  }

  const active = admitted.filter(runner => runner.state === 'active')

  if (active.length === 0) {
    return {
      kind: 'all-disabled',
      summary: matching.length === 1
        ? 'The only runner that matches this job is disabled.'
        : `All ${matching.length} runners that match this job are disabled.`,
      fix: 'Enable it in the admin area, or register another runner with these labels.',
      wanted,
      available,
    }
  }

  /*
   * Liveness, then holds - in that order because a hold is only believed from
   * a machine that is still saying it. A runner that went quiet mid-hold left
   * its last reason on the row, and "holding: out of disk" about a machine
   * that has been off for a day sends somebody to clean a disk that is not the
   * problem.
   */
  const online = active.filter(runner => isOnline(runner, now))

  if (online.length === 0) {
    return {
      kind: 'offline',
      summary: `Waiting: ${active.map(runner => `${nameOf(runner)} ${silence(runner, now)}`).join('; ')}.`,
      fix: active.length === 1
        ? 'Start the runner on that machine, or check that it can still reach this instance.'
        : 'Start one of those runners, or check that they can still reach this instance.',
      wanted,
      available,
    }
  }

  const taking = online.filter(runner => !runner.holdReason)

  if (taking.length === 0) {
    const held = online.map(runner => `${nameOf(runner)} is holding${since(runner.holdStartedAt, now)}: ${String(runner.holdReason).replace(/[.\s]+$/, '')}`)
    const quiet = active.filter(runner => !online.includes(runner)).map(runner => `${nameOf(runner)} ${silence(runner, now)}`)

    return {
      kind: 'holding',
      summary: `Waiting: ${[...held, ...quiet].join('; ')}.`,
      // The runner resumes by itself on the first poll after the condition
      // clears, so the fix is the condition, never the job.
      fix: 'Free what the runner says it is short of; it starts taking work again on its next poll without a restart.',
      wanted,
      available,
    }
  }

  return {
    kind: 'ready',
    summary: taking.length === 1
      ? 'A runner matches this job and will take it on its next poll.'
      : `${taking.length} runners match this job; the next one to poll will take it.`,
    // Nothing to fix: this is the ordinary case, and inventing advice for it
    // would teach people to ignore the line that matters.
    fix: '',
    wanted,
    available,
  }
}

/** Whether a runner has polled recently enough to be believed. */
function isOnline(runner: FleetRunner, now: Date): boolean {
  if (runner.lastSeenAt === undefined)
    return true

  const seen = runner.lastSeenAt ? Date.parse(runner.lastSeenAt) : Number.NaN

  return Number.isFinite(seen) && (now.getTime() - seen) / 1000 <= SILENT_SECONDS
}

function nameOf(runner: FleetRunner): string {
  return runner.name || `runner ${runner.id}`
}

/** `has not polled since 2026-10-30 22:04 UTC (11 hours ago)`, or `has never polled`. */
function silence(runner: FleetRunner, now: Date): string {
  const seen = runner.lastSeenAt ? Date.parse(runner.lastSeenAt) : Number.NaN

  if (!Number.isFinite(seen))
    return 'is offline: it has never polled this instance'

  return `is offline: last seen ${stamp(seen)} (${ago(now.getTime() - seen)} ago)`
}

/** ` since 2026-10-30 22:04 UTC`, or nothing when the start is unknown. */
function since(startedAt: string | null | undefined, now: Date): string {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN

  return Number.isFinite(started) ? ` since ${stamp(started)} (${ago(now.getTime() - started)})` : ''
}

/** Minutes, in UTC, said the same way on every page and in every API answer. */
function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))

  if (minutes < 1)
    return 'under a minute'
  if (minutes < 90)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`

  const hours = Math.round(minutes / 60)

  if (hours < 48)
    return `${hours} hours`

  return `${Math.round(hours / 24)} days`
}

/** `a`, `b` and `c` - the shape a sentence wants rather than a JSON array. */
function list(values: readonly string[]): string {
  const quoted = values.map(value => `\`${value}\``)

  if (quoted.length <= 1)
    return quoted[0] ?? 'no labels'

  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}
