/**
 * Watching a run while it runs.
 *
 * The run screen is the one page in this product somebody sits and stares at.
 * A build takes minutes; a page that shows what was true when it loaded means
 * the reader reloads it every thirty seconds, which is both worse for them and
 * more work for the server than a poll that knows when to stop.
 *
 * Three rules, and the first two are the same ones `live.ts` follows for pull
 * requests.
 *
 * **It never rewrites what the server rendered.** New output is appended after
 * what is already on screen and the states beside each job are updated in
 * place; nothing already there is replaced. A reader who has scrolled to the
 * failure in job three does not get moved.
 *
 * **Polling is the whole mechanism**, not a fallback. There is no socket here
 * yet, and when there is one the poll stays: a socket that reconnects has no
 * idea what it missed, and the cursor this carries is what makes catching up
 * cheap.
 *
 * **It stops.** When the run reaches a terminal state the polling ends, because
 * a finished run cannot change and a tab left open overnight on a build that
 * ended at lunchtime should cost nothing. A hidden tab backs off rather than
 * stopping, since coming back to a stale page is the thing this exists to
 * prevent.
 */

export interface RunJobState {
  id: number
  job_id: string
  name: string | null
  state: string
  runner: string | null
  started_at: string | null
  finished_at: string | null
}

export interface RunSnapshot {
  number: number
  state: string
  jobs: RunJobState[]
}

export interface WatchRunOptions {
  owner: string
  repository: string
  number: number
  /** Every reading, changed or not. */
  onRun: (snapshot: RunSnapshot) => void
  /** Once, when the run reaches a state it cannot leave. */
  onFinished?: (state: string) => void
}

/**
 * Named `RunLiveHandle` rather than `LiveHandle` because `live.ts` owns that
 * name, and the auto-import barrel is one namespace - two exports of a name,
 * type or not, make it fail to compile and take every other function in
 * `resources/functions/` with it.
 */
export interface RunLiveHandle {
  stop: () => void
}

/** States a run cannot leave; the reason to stop asking. */
const TERMINAL = ['succeeded', 'failed', 'cancelled']

/** The same, for one job. `skipped` is a job the graph decided not to run. */
const JOB_TERMINAL = ['succeeded', 'failed', 'cancelled', 'skipped']

/**
 * How often to ask, given what is happening.
 *
 * Faster while something is running and slower while everything is queued,
 * because a queued run changes when a runner picks it up and that is not
 * something the reader is watching second by second. Hidden tabs back off hard:
 * a phone in a pocket polling a two-hour build every three seconds is somebody
 * else's battery.
 */
export function intervalFor(state: string, hidden: boolean): number {
  if (hidden)
    return 60_000

  return state === 'running' || state === 'cancelling' ? 3000 : 10_000
}

export function watchRun(options: WatchRunOptions): RunLiveHandle {
  let stopped = false
  let timer: any = null

  const query = () => new URLSearchParams({
    owner: options.owner,
    repo: options.repository,
    number: String(options.number),
  }).toString()

  async function read(): Promise<void> {
    if (stopped)
      return

    try {
      const answer = await fetch(`/api/repos/workflow-runs/show?${query()}`, {
        headers: { Accept: 'application/json' },
      })

      if (!answer.ok)
        return schedule(30_000)

      const body = await answer.json() as { workflow_run?: RunSnapshot }
      const run = body.workflow_run

      if (!run)
        return schedule(30_000)

      options.onRun(run)

      if (TERMINAL.includes(String(run.state))) {
        options.onFinished?.(String(run.state))
        stop()
        return
      }

      schedule(intervalFor(String(run.state), isHidden()))
    }
    catch {
      // A failed read is not a reason to give up: the reader may have walked
      // away from a laptop that lost its network, and stopping would leave the
      // page silently stale from then on.
      schedule(30_000)
    }
  }

  function schedule(ms: number): void {
    if (stopped)
      return

    clearTimeout(timer)
    timer = setTimeout(read, ms)
  }

  function stop(): void {
    stopped = true
    clearTimeout(timer)
  }

  read()

  return { stop }
}

export interface WatchLogOptions {
  owner: string
  repository: string
  /** The job's row id, which is what the log endpoint is keyed on. */
  job: number
  /** The last sequence the server already rendered. Nothing before it is asked for. */
  after: number
  /** Called with each new piece of output, in order. */
  onOutput: (text: string) => void
  /** Called with the job's state on every reading, changed or not. */
  onState?: (state: string) => void
}

/**
 * Follow one job's output from where the page left off.
 *
 * The cursor is the whole trick. The server rendered everything up to sequence
 * N; this asks for what came after, so a job that has already printed two
 * megabytes costs nothing to follow and the reader never sees a line twice.
 *
 * Chunks are handed over as they arrive rather than accumulated here, because
 * the caller is a template that appends them - and holding a second copy of a
 * log this page already has is how a tab open on a long build runs out of
 * memory.
 */
export function watchJobLog(options: WatchLogOptions): RunLiveHandle {
  let stopped = false
  let timer: any = null
  let finishing = false
  let cursor = Number(options.after) || 0

  async function read(): Promise<void> {
    if (stopped)
      return

    try {
      const parameters = new URLSearchParams({
        owner: options.owner,
        repo: options.repository,
        job: String(options.job),
        after: String(cursor),
      })

      const answer = await fetch(`/api/repos/workflow-runs/log?${parameters}`, {
        headers: { Accept: 'application/json' },
      })

      if (!answer.ok)
        return schedule(30_000)

      const page = await answer.json() as { chunks?: Array<{ content?: string }>, cursor?: number, state?: string }

      for (const chunk of page.chunks ?? []) {
        const text = String(chunk?.content ?? '')

        if (text)
          options.onOutput(text)
      }

      // Only forward. A cursor that went backwards - a bad answer, a proxy
      // caching something stale - would replay output the reader has seen.
      cursor = Math.max(cursor, Number(page.cursor) || cursor)

      const state = String(page.state ?? '')

      if (state)
        options.onState?.(state)

      /*
       * The job's own state decides when to stop, which is why the endpoint
       * sends it. A job can be quiet for a minute in the middle of a step and
       * quiet forever after it ends, and from the chunks alone those look
       * identical - so a follower without this either stops early on a slow
       * step or polls a finished job until the tab closes.
       *
       * One last read after it turns terminal, because the final chunk and the
       * final state can land in that order.
       */
      if (JOB_TERMINAL.includes(state)) {
        if (finishing) {
          stop()
          return
        }

        finishing = true
        schedule(1500)
        return
      }

      schedule(isHidden() ? 30_000 : 2000)
    }
    catch {
      schedule(30_000)
    }
  }

  function schedule(ms: number): void {
    if (stopped)
      return

    clearTimeout(timer)
    timer = setTimeout(read, ms)
  }

  function stop(): void {
    stopped = true
    clearTimeout(timer)
  }

  read()

  return { stop }
}

/**
 * Whether nobody is looking.
 *
 * Guarded rather than read directly: this module is imported by a template that
 * also renders on the server, where `document` does not exist, and an
 * unguarded read there throws inside the script and takes the page with it.
 */
function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}
