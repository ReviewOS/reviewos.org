/**
 * Stopping without dropping anything.
 *
 * A deploy sends `SIGTERM` and then, some seconds later, `SIGKILL`. What
 * happens in between is the whole of this file, and getting it wrong is
 * invisible until it is a support thread: a push cut off mid-`receive-pack`
 * leaves a repository with objects and no ref, and a job killed halfway through
 * a mirror sync leaves a half-fetched remote.
 *
 * Three things, in this order, and the order is the design:
 *
 * 1. **Fail the health check immediately.** The load balancer needs a few
 *    seconds to notice and stop sending new requests, and those seconds have to
 *    happen *before* the socket closes. Skipping this is why "zero-downtime"
 *    deploys drop requests: the process stops accepting while traffic is still
 *    being routed to it.
 * 2. **Stop taking new work**, both HTTP and queue.
 * 3. **Let what is in flight finish**, up to a deadline.
 *
 * The deadline matters because the alternative to a deadline is hanging
 * forever, and an orchestrator that waits thirty seconds and then sends
 * `SIGKILL` turns "wait for the long job" into "get killed mid-write" - which
 * is the outcome this exists to prevent.
 */

import process from 'node:process'

export type Phase = 'running' | 'draining' | 'stopped'

export interface ShutdownState {
  phase: Phase
  /** In-flight work that must finish before the process may exit. */
  inFlight: number
}

const state: ShutdownState = { phase: 'running', inFlight: 0 }

/**
 * How long to let in-flight work finish.
 *
 * Twenty-five seconds, under the thirty most orchestrators allow before
 * `SIGKILL` - Docker, Kubernetes and systemd all default to about that. Being
 * *under* it is the point: a process that exits on its own terms has finished
 * its writes, and one that is killed has not.
 */
const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 25_000)

/**
 * How long to keep serving after failing the health check, before refusing.
 *
 * A load balancer polls every few seconds and needs two or three failures to
 * take an instance out. Five seconds of *still answering while reporting
 * unhealthy* is what makes a deploy lose nothing, and it is the step people
 * leave out.
 */
const DRAIN_LEAD_MS = Number(process.env.SHUTDOWN_LEAD_MS ?? 5_000)

/** Whether this process is still willing to take new work. */
export function accepting(): boolean {
  return state.phase === 'running'
}

/**
 * Whether the health endpoint should report failure.
 *
 * True from the moment a signal arrives, which is earlier than the process
 * stops serving. That gap is deliberate and is the whole mechanism.
 */
export function draining(): boolean {
  return state.phase !== 'running'
}

export function snapshot(): ShutdownState {
  return { ...state }
}

/**
 * Mark a unit of work as in flight until it settles.
 *
 * Wrapped rather than incremented by hand at call sites, because a `finally`
 * somebody forgets is a counter that never returns to zero and a process that
 * never exits - which reads as a hung deploy, days after the code was written.
 */
export async function inFlight<T>(work: () => Promise<T>): Promise<T> {
  state.inFlight += 1

  try {
    return await work()
  }
  finally {
    state.inFlight -= 1
  }
}

/**
 * Begin shutting down, and resolve when it is safe to exit.
 *
 * `stop` is whatever closes the listening socket. It is called *after* the
 * lead time, not immediately, so the load balancer has already stopped routing
 * here by the time the socket goes.
 */
export async function drain(options: {
  stop?: () => void | Promise<void>
  leadMs?: number
  deadlineMs?: number
  /** Injected so the timing can be tested without waiting half a minute. */
  sleep?: (ms: number) => Promise<void>
} = {}): Promise<{ finished: boolean, abandoned: number }> {
  if (state.phase !== 'running')
    return { finished: state.inFlight === 0, abandoned: state.inFlight }

  const rest = options.sleep ?? ((ms: number) => Bun.sleep(ms))

  // Step one: report unhealthy, keep serving. The gap between these is the
  // thing that makes a deploy lose nothing.
  state.phase = 'draining'

  await rest(options.leadMs ?? DRAIN_LEAD_MS)

  // Step two: stop accepting.
  await options.stop?.()

  // Step three: let what is in flight finish, up to the deadline.
  const deadline = Date.now() + (options.deadlineMs ?? DRAIN_MS)

  while (state.inFlight > 0 && Date.now() < deadline)
    await rest(50)

  state.phase = 'stopped'

  /*
   * Reported rather than swallowed. A deploy that abandons work should say how
   * much: it is the difference between "the drain window is too short" and
   * "something is stuck", and neither is discoverable from a process that
   * exited quietly.
   */
  return { finished: state.inFlight === 0, abandoned: state.inFlight }
}

/** For tests, which need a process that has not been shut down. */
export function resetShutdown(): void {
  state.phase = 'running'
  state.inFlight = 0
}

/**
 * Wire the signals a deploy actually sends.
 *
 * `SIGTERM` from every orchestrator, `SIGINT` from a terminal. Both drain;
 * a second signal exits immediately, because somebody pressing Ctrl-C twice
 * means it.
 */
export function onSignals(stop: () => void | Promise<void>): void {
  let signalled = false

  const handle = async (signal: string) => {
    if (signalled) {
      console.error(`[shutdown] ${signal} again - exiting now, ${state.inFlight} in flight`)
      process.exit(1)
      return
    }

    signalled = true
    console.error(`[shutdown] ${signal} - draining`)

    const outcome = await drain({ stop })

    if (!outcome.finished)
      console.error(`[shutdown] deadline reached with ${outcome.abandoned} still in flight`)

    process.exit(outcome.finished ? 0 : 1)
  }

  process.on('SIGTERM', () => void handle('SIGTERM'))
  process.on('SIGINT', () => void handle('SIGINT'))
}
