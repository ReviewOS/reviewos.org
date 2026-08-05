/**
 * A small Chrome DevTools Protocol client.
 *
 * Enough of it to launch a browser, drive a page and record a trace, and no
 * more. A dependency would bring a browser download, a driver protocol and a
 * plugin system to do what four methods and a WebSocket do here, and this
 * project does not take dependencies it can write in an afternoon.
 *
 * The browser is launched with its own profile directory under the system
 * temporary directory and removed afterwards, so a benchmark never touches
 * whatever Chrome the person running it uses.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where Chrome lives, in the order worth looking. */
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export function findChrome(): string | null {
  if (process.env.CHROME_PATH)
    return process.env.CHROME_PATH

  for (const path of CHROME_PATHS) {
    if (Bun.file(path).size > 0)
      return path
  }

  return null
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

/**
 * One connection to one target.
 *
 * Requests are matched to responses by id, which is the whole protocol. Events
 * are handed to subscribers, because a trace arrives as several thousand of
 * them rather than as a reply.
 */
export class CdpSession {
  private socket: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Array<(params: any) => void>>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))

      if (typeof message.id === 'number') {
        const waiting = this.pending.get(message.id)
        this.pending.delete(message.id)

        if (message.error)
          waiting?.reject(new Error(`${message.error.message} (${message.error.code})`))
        else
          waiting?.resolve(message.result)

        return
      }

      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params)
    })
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url)

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)), { once: true })
    })

    return new CdpSession(socket)
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  on(method: string, listener: (params: any) => void): void {
    const existing = this.listeners.get(method)
    if (existing)
      existing.push(listener)
    else
      this.listeners.set(method, [listener])
  }

  /** Evaluate an expression in the page and wait for its promise. */
  async evaluate<T = any>(expression: string): Promise<T> {
    const result = await this.send<{ result: any, exceptionDetails?: any }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })

    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'Evaluation failed'
      throw new Error(String(text))
    }

    return result.result?.value as T
  }

  close(): void {
    this.socket.close()
  }
}

export interface Browser {
  session: CdpSession
  close: () => Promise<void>
}

/**
 * Launch a browser and attach to a fresh page.
 *
 * Headless by default. Pass `headed` when a trace is being compared against one
 * recorded headed: the two are not comparable, because compositing differs, and
 * mixing them is the easiest way to measure nothing.
 */
export async function launch(options: { port?: number, headed?: boolean } = {}): Promise<Browser> {
  const binary = findChrome()
  if (!binary)
    throw new Error('No Chrome found. Set CHROME_PATH to one.')

  const port = options.port ?? 9333
  const profile = mkdtempSync(join(tmpdir(), 'reviewos-bench-'))

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // A background tab is throttled to something like one frame a second, and
    // a benchmark that lands in one measures the throttle rather than the page.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1440,1000',
    'about:blank',
  ]

  if (!options.headed)
    args.unshift('--headless=new')

  const child: ChildProcess = spawn(binary, args, { stdio: 'ignore' })

  // The port takes a moment to open. Polled rather than slept on, so a fast
  // machine does not wait and a slow one is not cut off.
  let version: { webSocketDebuggerUrl: string } | null = null
  for (let attempt = 0; attempt < 100 && version === null; attempt++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as typeof version
    }
    catch {
      await Bun.sleep(100)
    }
  }

  if (!version)
    throw new Error('Chrome started but never opened its debugging port')

  const browser = await CdpSession.connect(version.webSocketDebuggerUrl)
  const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{
    id: string
    webSocketDebuggerUrl: string
  }>
  const page = targets.find(target => target.id === targetId)
  if (!page)
    throw new Error('Chrome opened a page and then lost it')

  const session = await CdpSession.connect(page.webSocketDebuggerUrl)
  await session.send('Page.enable')
  await session.send('Runtime.enable')

  return {
    session,
    async close() {
      session.close()
      browser.close()
      child.kill('SIGKILL')
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

/** Navigate and wait for the load event. */
export async function goto(session: CdpSession, url: string): Promise<void> {
  const loaded = new Promise<void>((resolve) => {
    session.on('Page.loadEventFired', () => resolve())
  })

  await session.send('Page.navigate', { url })
  await Promise.race([loaded, Bun.sleep(30_000)])
}

export interface TraceEvent {
  ph?: string
  name?: string
  dur?: number
  pid?: number
  tid?: number
  args?: { name?: string }
}

/**
 * Record a trace while running something in the page.
 *
 * The categories are the ones that carry renderer-main work. Recording
 * everything produces a file several times the size for questions nobody asked.
 */
export async function trace<T>(
  session: CdpSession,
  run: () => Promise<T>,
): Promise<{ result: T, events: TraceEvent[] }> {
  const events: TraceEvent[] = []
  session.on('Tracing.dataCollected', params => events.push(...(params.value ?? [])))

  const finished = new Promise<void>((resolve) => {
    session.on('Tracing.tracingComplete', () => resolve())
  })

  await session.send('Tracing.start', {
    traceConfig: {
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'blink',
        'cc',
        'toplevel',
      ],
    },
    transferMode: 'ReportEvents',
  })

  const result = await run()

  await session.send('Tracing.end')
  await Promise.race([finished, Bun.sleep(30_000)])

  return { result, events }
}

/**
 * Time spent per phase on the renderer's main thread.
 *
 * Only that thread: work on a worker or the compositor is real but is not what
 * a stuttering scroll is usually made of, and mixing them hides the signal.
 */
export function summarizeTrace(events: readonly TraceEvent[], names: readonly string[]): Record<string, number> {
  const threads = new Map<string, string>()
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name')
      threads.set(`${event.pid}:${event.tid}`, String(event.args?.name ?? ''))
  }

  const totals: Record<string, number> = {}
  for (const name of names)
    totals[name] = 0

  for (const event of events) {
    if (event.ph !== 'X' || event.name == null || !(event.name in totals))
      continue
    if (threads.get(`${event.pid}:${event.tid}`) !== 'CrRendererMain')
      continue

    totals[event.name]! += (event.dur ?? 0) / 1000
  }

  for (const name of names)
    totals[name] = Math.round(totals[name]! * 10) / 10

  return totals
}
