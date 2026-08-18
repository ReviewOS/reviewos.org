/**
 * How a run's state is said and shown.
 *
 * One mapping, used by every screen, derived from the states
 * `app/Actions/Workflow/states.ts` defines. Phase 15 asks for the interface,
 * the API and the webhooks to read the same states rather than three
 * vocabularies, and the way that goes wrong is not a disagreement about the
 * data - it is a screen inventing a friendlier word for one of them. Then
 * "stopping" appears in the interface, `cancelling` in the API, and somebody
 * has to know they are the same thing.
 *
 * So the label is the state, capitalised. The only judgement here is the tone,
 * which is presentation and belongs on this side of the line.
 */

export type RunTone = 'neutral' | 'running' | 'good' | 'bad' | 'warn'

/** Every state a run can be in, in the order a person would list them. */
export const RUN_STATES = [
  'queued', 'running', 'waiting', 'paused',
  'cancelling', 'cancelled', 'failed', 'succeeded',
] as const

const TONES: Record<string, RunTone> = {
  queued: 'neutral',
  running: 'running',
  waiting: 'warn',
  paused: 'warn',
  cancelling: 'warn',
  cancelled: 'neutral',
  failed: 'bad',
  succeeded: 'good',

  // Job states that runs do not have.
  blocked: 'neutral',
  skipped: 'neutral',
  pending: 'neutral',
}

export function runTone(state: string): RunTone {
  return TONES[String(state)] ?? 'neutral'
}

/**
 * The word for a state.
 *
 * The state itself, with a capital. Not a synonym: a screen that says
 * "Stopping" where the API says `cancelling` has created a second vocabulary
 * for somebody to translate between, usually while trying to work out why a
 * build did not stop.
 */
export function runLabel(state: string): string {
  const text = String(state ?? '').trim()
  if (!text)
    return 'Unknown'

  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Whether a run is still going.
 *
 * Kept beside the tone because both screens ask it and the answer has to match
 * the state machine's idea of terminal rather than a list written out again.
 */
export function runIsFinished(state: string): boolean {
  return ['cancelled', 'failed', 'succeeded'].includes(String(state))
}

/** How long a run took, or has been going, in words. */
export function runDuration(startedAt: unknown, finishedAt: unknown): string {
  const started = startedAt ? Date.parse(String(startedAt)) : Number.NaN
  if (!Number.isFinite(started))
    return ''

  const ended = finishedAt ? Date.parse(String(finishedAt)) : Date.now()
  if (!Number.isFinite(ended))
    return ''

  const seconds = Math.max(0, Math.round((ended - started) / 1000))

  if (seconds < 60)
    return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * An artifact's size, in the units a person reads.
 *
 * Re-exported from `app/Actions/Artifact/storage.ts` rather than written again
 * here: the API answers with the same string, and a page that computed its own
 * would eventually disagree with the endpoint about a megabyte.
 */
import { megabytes as megabytesImpl } from '../../app/Actions/Artifact/storage'

export const artifactSize = megabytesImpl

/**
 * A job's output, rendered.
 *
 * Re-exported one name at a time rather than with `export … from`, which the
 * stx composable loader cannot parse - it fails by leaving every binding
 * undefined rather than by saying so.
 */
import { eventsFromText as eventsFromTextImpl, renderLog as renderLogImpl } from '../../app/Actions/Runner/logrender'

export const renderLog = renderLogImpl
export const eventsFromText = eventsFromTextImpl

/**
 * Why a queued job is still queued.
 *
 * Re-exported one name at a time, for the reason above: `export … from` leaves
 * every binding undefined rather than failing, which is the worst way for an
 * import to be wrong.
 */
import { explainWaiting as explainWaitingImpl } from '../../app/Actions/Workflow/waiting'

export const explainWaiting = explainWaitingImpl

/**
 * Starter workflows for a repository that has none.
 *
 * One name at a time again: `export … from` leaves every binding undefined
 * rather than failing, which is the worst way for an import to be wrong.
 */
import { startersFor as startersForImpl } from '../../app/Actions/Workflow/templates'

export const startersFor = startersForImpl

import { criticalPath as criticalPathImpl, layersOf as layersOfImpl, waitingOn as waitingOnImpl } from '../../app/Actions/Workflow/graph'

/**
 * The shape of a run: dependency layers, what a blocked job waits for, and the
 * chain that decided how long the whole thing took.
 *
 * A list of jobs cannot say either of the last two, and both are the questions
 * somebody opens a slow or stuck run to answer.
 */
export const layersOf = layersOfImpl
export const criticalPath = criticalPathImpl
export const waitingOn = waitingOnImpl

import { searchLog as searchLogImpl } from '../../app/Actions/Workflow/logSearch'

/**
 * The lines of a job's output that contain a query, with the line numbers a
 * link can point at. A failed job prints ten thousand lines and the one that
 * matters says `error TS2345`.
 */
export const searchLog = searchLogImpl
