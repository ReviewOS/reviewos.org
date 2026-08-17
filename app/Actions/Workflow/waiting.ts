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

import type { JobFacts, RunnerFacts } from '../Runner/protocol'
import { runnerReaches, runnerSatisfies } from '../Runner/protocol'

export type WaitingKind =
  | 'ready'
  | 'no-runners'
  | 'none-reach'
  | 'no-labels'
  | 'all-busy'
  | 'all-disabled'

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
export function explainWaiting(job: JobFacts, runners: readonly RunnerFacts[]): WaitingExplanation {
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

  const active = matching.filter(runner => runner.state === 'active')

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

  return {
    kind: 'ready',
    summary: active.length === 1
      ? 'A runner matches this job and will take it on its next poll.'
      : `${active.length} runners match this job; the next one to poll will take it.`,
    // Nothing to fix: this is the ordinary case, and inventing advice for it
    // would teach people to ignore the line that matters.
    fix: '',
    wanted,
    available,
  }
}

/** `a`, `b` and `c` - the shape a sentence wants rather than a JSON array. */
function list(values: readonly string[]): string {
  const quoted = values.map(value => `\`${value}\``)

  if (quoted.length <= 1)
    return quoted[0] ?? 'no labels'

  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}
