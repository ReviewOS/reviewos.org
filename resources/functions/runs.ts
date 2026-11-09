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

import { RUN_STATES as states, runTone as tone, runLabel as label, runIsFinished as finished, runDuration as duration, millisFor as millis } from '../lib/runStatus'
export type { RunTone } from '../lib/runStatus'
export const RUN_STATES = states
export const runTone = tone
export const runLabel = label
export const runIsFinished = finished
export const runDuration = duration
export const millisFor = millis

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

import { waitingFleet as waitingFleetImpl } from '../../app/Actions/Workflow/waitingFleet'

export const waitingFleet = waitingFleetImpl

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

/**
 * Which pools somebody maintains.
 *
 * Here so the token screen can offer the `fleet` scope to the people it means
 * anything for. A scope on that form that nobody in the room can use is a line
 * a reader has to decide about every time they issue a token.
 */
import { poolsMaintainedBy as poolsMaintainedByImpl } from '../../app/Actions/Runner/fleet'

export const poolsMaintainedBy = poolsMaintainedByImpl

/**
 * A duration in milliseconds, as a person reads it.
 *
 * Separate from `runDuration` above, which takes two timestamps: a step reports
 * its queue time and its active time as numbers, and turning them back into
 * timestamps to reuse one formatter would be arithmetic in the wrong direction.
 *
 * Sub-second values keep a decimal. A step that took 400ms and one that took
 * 900ms both reading "0s" is a table that cannot tell them apart, and the whole
 * reason these two numbers are stored separately is to be able to.
 */
