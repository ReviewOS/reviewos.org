/**
 * The other half of the journal: what a workflow program actually calls.
 *
 * `POST /api/runner/orchestrator` is the whole protocol, and this is the client
 * for it. A code-first workflow is a program that runs **on a runner**, holding
 * a lease like any other untrusted work, and every durable thing it does comes
 * back here as an authenticated request. The control plane never imports,
 * transpiles, or evaluates repository code - that decision is written up in
 * `OrchestratorCallAction`, and this file is what makes it usable rather than
 * merely stated.
 *
 * ## The sequence is taken synchronously, and that is the whole trick
 *
 * A call's identity is its position, so two runs of the same program must
 * number their calls the same way. `next()` is called before the first `await`
 * in every method here, which means positions are assigned in the order the
 * program *makes* the calls rather than the order their promises happen to
 * settle. Without that, `Promise.all([step('a'), step('b')])` would number
 * itself by whichever request came back first, and a replay would report
 * divergence on a program that did nothing wrong.
 *
 * ## The three ways a program stops
 *
 * - **`StepFailed`** - a step failed. An ordinary error the program may catch,
 *   and on replay it is thrown again with the same message, so a `try` that
 *   handled it the first time handles it the same way the second.
 * - **`Suspended`** - this run is waiting: on a sleep, or on somebody else's
 *   in-flight call. The program stops and the runner lets go of its lease,
 *   which is the difference between a workflow that can wait three days and one
 *   that holds a machine for three days.
 * - **`RunOver`** - divergence or a spent budget. Not retryable by anyone; the
 *   journal describes a run that no longer exists.
 */

import { PROTOCOL_HEADER, RUNNER_PROTOCOL } from './protocol'

/** What the endpoint answers. */
export interface CallDecision {
  decision: 'replay' | 'dispatch' | 'wait' | 'failed' | 'diverged' | 'refused'
  result?: unknown
  entry_id?: number
  reason?: string
  wake_at?: string | null
}

/**
 * How this client reaches the control plane.
 *
 * An interface rather than a `fetch` call inline, because the behaviour worth
 * testing - sequence numbering, replay, what a failed step does to a `try` -
 * has nothing to do with HTTP, and a test that needs a server to check it is a
 * test nobody runs.
 */
export interface OrchestratorTransport {
  call: (body: { sequence: number, kind: string, name: string, arguments: unknown }) => Promise<CallDecision>
  report: (body: { entry_id: number, result?: unknown, error?: string, duration_ms?: number }) => Promise<void>
}

/** A step that failed. Catchable, and replayed as the same failure. */
export class StepFailed extends Error {
  constructor(public readonly step: string, message: string) {
    super(message)
    this.name = 'StepFailed'
  }
}

/** This run is waiting. Stop, and give the machine back. */
export class Suspended extends Error {
  constructor(public readonly wakeAt: string | null) {
    super(wakeAt
      ? `this run is sleeping until ${wakeAt}`
      : 'this call is already being made by another orchestrator for this run')
    this.name = 'Suspended'
  }
}

/** The journal and the program disagree, or a budget is spent. */
export class RunOver extends Error {
  constructor(public readonly decision: 'diverged' | 'refused', message: string) {
    super(message)
    this.name = 'RunOver'
  }
}

/** What a workflow program is handed. */
export interface OrchestratorContext {
  /**
   * Do something once, ever.
   *
   * `work` runs only when this call is new. On every later run of the program
   * it is not called at all and the recorded value comes back instead, which is
   * what makes a killed orchestrator resume rather than restart.
   */
  step: <T>(name: string, work: () => T | Promise<T>, args?: unknown) => Promise<T>
  /** Wait, without holding a machine while waiting. */
  sleep: (name: string, ms: number) => Promise<void>
  /** The clock, journaled. A replay sees the time the first run saw. */
  now: () => Promise<Date>
  /** Randomness, journaled, for the same reason. */
  random: () => Promise<number>
  /** How many calls this program has made. For tests and for logs. */
  calls: () => number
}

export function orchestrator(transport: OrchestratorTransport): OrchestratorContext {
  let sequence = 0

  /*
   * Synchronous on purpose. See the header: positions must follow the order the
   * program made its calls, not the order the network answered them.
   */
  const next = (): number => (sequence += 1)

  async function decide(position: number, kind: string, name: string, args: unknown): Promise<CallDecision> {
    const decision = await transport.call({ sequence: position, kind, name, arguments: args })

    if (decision.decision === 'diverged' || decision.decision === 'refused')
      throw new RunOver(decision.decision, decision.reason ?? 'this run is over')

    return decision
  }

  return {
    async step<T>(name: string, work: () => T | Promise<T>, args: unknown = {}): Promise<T> {
      const position = next()
      const decision = await decide(position, 'step', name, args)

      if (decision.decision === 'replay')
        return decision.result as T

      /*
       * A failure is replayed as a failure rather than quietly re-run. A step
       * that failed is a decision the run already made; running it again on
       * restart turns one failed deploy into two attempted ones, which is the
       * class of problem durability exists to prevent.
       */
      if (decision.decision === 'failed')
        throw new StepFailed(name, decision.reason ?? 'the step failed')

      if (decision.decision === 'wait')
        throw new Suspended(decision.wake_at ?? null)

      const entryId = Number(decision.entry_id ?? 0)
      const startedAt = Date.now()

      let value: T
      try {
        value = await work()
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        // Reported before it is thrown, so the journal knows this call is
        // finished even though it finished badly. Left pending, a restart would
        // find it in flight and wait for a call nobody is making.
        await transport.report({ entry_id: entryId, error: message, duration_ms: Date.now() - startedAt })

        throw new StepFailed(name, message)
      }

      await transport.report({ entry_id: entryId, result: value, duration_ms: Date.now() - startedAt })

      return value
    },

    async sleep(name: string, ms: number): Promise<void> {
      const position = next()
      const decision = await decide(position, 'sleep', name, { ms: Math.max(0, Math.round(ms)) })

      // The server decides when a sleep is over, and says so by answering
      // `replay`. A runner that woke early - or whose clock is wrong - gets the
      // same answer as one that woke late.
      if (decision.decision === 'replay')
        return

      throw new Suspended(decision.wake_at ?? null)
    },

    async now(): Promise<Date> {
      const position = next()
      const decision = await decide(position, 'now', 'now', {})

      return new Date(String(decision.result ?? new Date().toISOString()))
    },

    async random(): Promise<number> {
      const position = next()
      const decision = await decide(position, 'random', 'random', {})

      return Number(decision.result ?? 0)
    },

    calls: () => sequence,
  }
}

/**
 * The real transport: the job's own credential, and nothing else.
 *
 * There is no run identifier in either request. The token *is* the claim on one
 * job of one run, so an orchestrator cannot journal a call against a run that
 * is not its own by getting a parameter wrong - because there is no parameter
 * to get wrong.
 */
export function httpTransport(options: { server: string, token: string }): OrchestratorTransport {
  const base = options.server.replace(/\/+$/, '')

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${options.token}`,
    [PROTOCOL_HEADER]: String(RUNNER_PROTOCOL.current),
  }

  async function post(path: string, body: unknown): Promise<any> {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await response.text()

    let payload: any = null
    try {
      payload = text ? JSON.parse(text) : null
    }
    catch {
      payload = null
    }

    /*
     * 409 is the end of the run, and it carries a decision rather than an
     * error. Treating it as a transport failure would send a well-behaved
     * client into retrying a divergence forever.
     */
    if (response.status === 409 && payload?.decision)
      return payload

    if (!response.ok)
      throw new Error(`the control plane answered ${response.status}: ${payload?.error ?? text.slice(0, 200)}`)

    return payload
  }

  return {
    call: body => post('/api/runner/orchestrator', body),
    report: async (body) => {
      await post('/api/runner/orchestrator/result', body)
    },
  }
}
