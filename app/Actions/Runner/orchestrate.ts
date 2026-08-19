/**
 * Running a workflow program, on the machine where running it is allowed.
 *
 * This is the far side of the boundary. The control plane knows a program
 * exists, knows when it wants to run, and knows every call it has ever made -
 * and has never read a line of it. Here, on a runner holding a lease, the file
 * is imported and driven.
 *
 * ## What "driving" means
 *
 * The program is an ordinary async function that takes a context and calls
 * `step()`. It runs **from its first line every time**, including after a
 * restart hours later - the journal is what makes the second run cheap, not the
 * program remembering anything. So there is no resume logic here, and that
 * absence is the design rather than an omission.
 *
 * ## Three ways it ends, and only one is a failure
 *
 * - **It returns.** The workflow is done.
 * - **It suspends.** A sleep, or a wait on an event. Not an error: the run is
 *   parked, the control plane holds the timer, and this machine's job is to
 *   *stop* so the lease goes back. Reporting that as a failure would turn every
 *   workflow that waits for an approval into a red cross.
 * - **It throws.** Either the run is over - divergence, a spent budget - or the
 *   program itself failed. Both fail the job, and the message says which.
 */

import { pathToFileURL } from 'node:url'
import { orchestrator, RunOver, Suspended } from './orchestratorClient'
import type { OrchestratorContext, OrchestratorTransport } from './orchestratorClient'

export interface OrchestrateOutcome {
  /** `done`, `suspended`, or `failed`. */
  state: 'done' | 'suspended' | 'failed'
  reason: string
  /** How many journaled calls the program made this time round. */
  calls: number
  /** When a suspension has a time attached. */
  wakeAt?: string | null
}

/**
 * Find the function to call in whatever the file exported.
 *
 * `export default` is the documented form, and `export const workflow` is
 * accepted because it is what people write when a file has one obvious export
 * and they would rather name it. Anything else is an error with a sentence
 * about what was expected - a program whose export is wrong should not read as
 * a program that ran and did nothing.
 */
export function entrypointOf(module: unknown): ((context: OrchestratorContext) => unknown) | null {
  const candidates = [
    (module as any)?.default,
    (module as any)?.workflow,
    (module as any)?.run,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'function')
      return candidate as (context: OrchestratorContext) => unknown

    // `export default { workflow() {} }`, which is what a file written as an
    // object literal produces.
    if (candidate && typeof (candidate as any).workflow === 'function')
      return (candidate as any).workflow
  }

  return null
}

export const MISSING_ENTRYPOINT
  = 'A workflow program must export the function that runs it: `export default async function (workflow) { ... }`. '
    + 'This file exported no function, so there was nothing to run.'

/**
 * Drive one attempt at a program.
 *
 * The transport is a parameter so this can be tested without a control plane,
 * and `load` is one so it can be tested without a file - the interesting
 * behaviour is what happens to a program that suspends or throws, and neither
 * of those is a question about module resolution.
 */
export async function drive(
  file: string,
  transport: OrchestratorTransport,
  load: (path: string) => Promise<unknown> = path => import(pathToFileURL(path).href),
): Promise<OrchestrateOutcome> {
  const context = orchestrator(transport)

  let program: ((_context: OrchestratorContext) => unknown) | null = null

  try {
    program = entrypointOf(await load(file))
  }
  catch (error) {
    /*
     * A file that will not import is a failure of the workflow, not of this
     * runner, and it is reported with the error the import gave - a syntax
     * error names its line, and "the workflow failed" does not.
     */
    return {
      state: 'failed',
      calls: context.calls(),
      reason: `the workflow program could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!program)
    return { state: 'failed', calls: context.calls(), reason: MISSING_ENTRYPOINT }

  try {
    await program(context)

    return { state: 'done', calls: context.calls(), reason: 'the workflow program finished' }
  }
  catch (error) {
    if (error instanceof Suspended) {
      /*
       * Not a failure. The run is parked and this machine's job is to stop, so
       * the lease goes back and somebody else's build gets the capacity.
       */
      return {
        state: 'suspended',
        calls: context.calls(),
        wakeAt: error.wakeAt,
        reason: error.wakeAt
          ? `the workflow is waiting until ${error.wakeAt}`
          : 'the workflow is waiting',
      }
    }

    if (error instanceof RunOver) {
      return { state: 'failed', calls: context.calls(), reason: error.message }
    }

    return {
      state: 'failed',
      calls: context.calls(),
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
