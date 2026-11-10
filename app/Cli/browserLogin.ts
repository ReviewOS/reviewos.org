/**
 * Signing in through the browser, from the terminal's side.
 *
 * `reviewos login` used to ask for an access token, and the honest answer for
 * most people was "I have no idea what that is". Now it opens the instance in
 * a browser, the person says yes there, and the token arrives here without
 * anybody seeing it. The server's half, and why the exchange is safe, is
 * `app/Actions/Tokens/cliLogin.ts`.
 *
 * Like everything under `app/Cli/`, this talks to the instance over HTTP and
 * imports nothing from the server: the hashing below is the standard library's,
 * repeated rather than shared, so the CLI stays a client.
 */

import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import process from 'node:process'

export interface LoginAttempt {
  /** Never leaves this process except in the exchange that redeems the code. */
  verifier: string
  challenge: string
  /** Echoed back on the redirect, so a callback nobody here asked for is ignored. */
  state: string
  device: string
}

export function newAttempt(device: string = hostname()): LoginAttempt {
  const verifier = randomBytes(32).toString('base64url')

  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(16).toString('base64url'),
    // A laptop is `name.local`; the suffix says nothing a person reads.
    device: device.replace(/\.(?:local|lan|home)$/i, '') || 'a terminal',
  }
}

/** The page to approve on. Without a port, the page shows a code to paste instead of redirecting. */
export function approvalUrl(instance: string, attempt: LoginAttempt, port?: number): string {
  const url = new URL('/cli/login', instance.endsWith('/') ? instance : `${instance}/`)
  url.searchParams.set('challenge', attempt.challenge)
  url.searchParams.set('state', attempt.state)
  url.searchParams.set('device', attempt.device)
  if (port)
    url.searchParams.set('port', String(port))

  return url.href
}

export type Callback
  = | { kind: 'code', code: string }
    | { kind: 'denied' }
    | { kind: 'ignored' }

/**
 * What a request to the loopback listener means.
 *
 * Anything without this attempt's `state` is ignored rather than treated as a
 * failure: a port on 127.0.0.1 is reachable by every page the browser has
 * open, and one of them guessing the port must not be able to end the wait.
 */
export function readCallback(requestUrl: string, attempt: LoginAttempt): Callback {
  const url = new URL(requestUrl)
  if (url.pathname !== '/callback' || url.searchParams.get('state') !== attempt.state)
    return { kind: 'ignored' }

  if (url.searchParams.get('error'))
    return { kind: 'denied' }

  const code = url.searchParams.get('code')

  return code ? { kind: 'code', code } : { kind: 'ignored' }
}

function page(title: string, line: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#111;background:#fff">`
    + `<h1 style="font-size:1.4rem;margin:0 0 .5rem">${title}</h1><p style="margin:0;color:#555">${line}</p>`

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}

export interface Listener {
  port: number
  /** Settles with the approval, the refusal, or null when nobody answered in time. */
  answer: Promise<Callback | null>
  stop: () => void
}

/** Listen on 127.0.0.1, on a port the system picks, for the browser coming back. */
export function listen(attempt: LoginAttempt, timeoutMs: number = 5 * 60 * 1000): Listener {
  let settle: (value: Callback | null) => void = () => {}
  const answer = new Promise<Callback | null>((resolve) => { settle = resolve })

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const callback = readCallback(request.url, attempt)
      if (callback.kind === 'ignored')
        return new Response('Not found', { status: 404 })

      settle(callback)

      return callback.kind === 'code'
        ? page('Signed in', 'You can close this tab and go back to your terminal.')
        : page('Not signed in', 'You refused the sign-in. Nothing was issued, and you can close this tab.')
    },
  })

  const timer = setTimeout(() => settle(null), timeoutMs)

  return {
    port: Number(server.port),
    answer,
    stop: () => {
      clearTimeout(timer)
      // Not forced: the page that says "signed in" is still on its way out.
      void server.stop()
    },
  }
}

/** The command that opens a URL in this platform's default browser. */
export function openerFor(platform: string = process.platform): string[] {
  if (platform === 'darwin')
    return ['open']
  if (platform === 'win32')
    return ['cmd', '/c', 'start', '""']

  return ['xdg-open']
}

/** Open the browser. False when there is none to open, which is a normal answer over ssh. */
export async function openBrowser(url: string, platform: string = process.platform): Promise<boolean> {
  try {
    const child = Bun.spawn([...openerFor(platform), url], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })

    return await child.exited === 0
  }
  catch {
    return false
  }
}
