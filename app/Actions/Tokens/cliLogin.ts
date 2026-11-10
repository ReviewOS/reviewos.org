import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { REPOSITORY_SCOPES } from '../../TokenScopes'

/**
 * Signing the command line in through the browser.
 *
 * `reviewos login` used to ask for an access token, which nobody has: it means
 * finding the settings page, choosing scopes for a tool whose needs you do not
 * know, copying a secret through the clipboard and pasting it into a terminal.
 * `npm login` and `gh auth login` do not ask for that, and neither does this.
 *
 * ## The shape
 *
 * 1. The CLI makes a random `verifier`, keeps it, and opens the browser on
 *    `/cli/login` with its SHA-256 (`challenge`), a `state`, the loopback port
 *    it is listening on and the machine's name.
 * 2. The person, signed in in that browser, reads what is asking and approves.
 * 3. The server answers with a redirect to `http://127.0.0.1:<port>/callback`
 *    carrying a `code`: who approved, for which challenge, until when, signed
 *    with the application key.
 * 4. The CLI posts the code and its verifier, and gets a token.
 *
 * ## Why it holds
 *
 * - **Nothing is stored.** The code is a signed statement, not a row, so there
 *   is no table of pending logins to expire, sweep or leak.
 * - **The code alone is worth nothing.** It passes through the browser's
 *   address bar and history, and it is redeemable only with the verifier, which
 *   never left the terminal that made it. That is PKCE, for the same reason
 *   OAuth has it.
 * - **The redirect goes to loopback and nowhere else.** The port is the only
 *   part of the target a request can choose, so approving cannot send a code to
 *   somebody else's server. A page that tricks a signed-in person into
 *   approving sends the code to that person's own machine.
 * - **It lives for two minutes.** Long enough for a redirect and a request,
 *   short enough that a code found in a history later is expired.
 *
 * A machine with no browser on it (an ssh session) cannot receive a redirect,
 * so the page can show the code instead and the CLI accepts it pasted. The
 * verifier still has to match, so the pasted code is as bound to that terminal
 * as the redirected one.
 */

/** How long an approval can be redeemed. A redirect and one request. */
export const CLI_GRANT_LIFETIME_MS = 2 * 60 * 1000

/** A SHA-256 in unpadded base64url, which is what the CLI sends as its challenge. */
const CHALLENGE = /^[\w-]{43}$/

/** What the CLI's verifier and state look like: 32 random bytes or more, base64url. */
const OPAQUE = /^[\w-]{20,128}$/

export interface CliGrant {
  userId: number
  challenge: string
  device: string
  expiresAtMs: number
}

let ephemeralKey = ''

/**
 * The key approvals are signed with.
 *
 * As `LoginAction` has it: a per-process random value when no `APP_KEY` is
 * set, never a constant, so an instance without one cannot have its approvals
 * forged by somebody who has read this file. They stop working across a
 * restart, which for something that lives two minutes costs nothing.
 */
function applicationKey(): string {
  const configured = String(process.env.APP_KEY ?? '').trim()

  if (configured)
    return configured

  if (!ephemeralKey)
    ephemeralKey = randomBytes(32).toString('hex')

  return ephemeralKey
}

function sign(payload: string): string {
  // The label keeps this signature from being valid anywhere else the same key signs.
  return createHmac('sha256', applicationKey()).update(`reviewos-cli-login.v1\n${payload}`).digest('base64url')
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function isChallenge(value: unknown): value is string {
  return typeof value === 'string' && CHALLENGE.test(value)
}

export function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE.test(value)
}

/**
 * The machine's name as it is shown and stored: printable, and short.
 *
 * It comes from whoever started the login, so it is text to display and
 * nothing else. Control characters and markup-shaped runs are dropped rather
 * than escaped later by whoever remembers to.
 */
export function deviceName(value: unknown): string {
  const cleaned = String(value ?? '').replace(/[^\w .()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)

  return cleaned || 'a terminal'
}

/**
 * The loopback port a code may be sent to, or null.
 *
 * Unprivileged ports only. The host is not a parameter at all: it is always
 * 127.0.0.1, so there is nothing here to get wrong into an open redirect.
 */
export function loopbackPort(value: unknown): number | null {
  const port = Number(value)

  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
}

export function loopbackUrl(port: number, query: Record<string, string>): string {
  const url = new URL(`http://127.0.0.1:${port}/callback`)
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value)

  return url.href
}

/** The statement "this account approved this challenge, until then", signed. */
export function sealCliGrant(input: { userId: number, challenge: string, device: string, nowMs?: number }): string {
  const grant: CliGrant = {
    userId: input.userId,
    challenge: input.challenge,
    device: deviceName(input.device),
    expiresAtMs: (input.nowMs ?? Date.now()) + CLI_GRANT_LIFETIME_MS,
  }
  const payload = Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url')

  return `${payload}.${sign(payload)}`
}

export type OpenedCliGrant
  = | { ok: true, grant: CliGrant }
    | { ok: false, error: string }

/**
 * Read an approval back, with the verifier that proves who asked for it.
 *
 * One message for every way a code can be wrong. Telling a caller whether it
 * was the signature, the expiry or the verifier tells somebody probing which
 * part they have right.
 */
export function openCliGrant(code: unknown, verifier: unknown, nowMs: number = Date.now()): OpenedCliGrant {
  const refused: OpenedCliGrant = { ok: false, error: 'That sign-in was not approved, or it has expired. Run `reviewos login` again.' }

  if (typeof code !== 'string' || !isOpaque(verifier))
    return refused

  const [payload, signature, ...rest] = code.split('.')
  if (!payload || !signature || rest.length > 0)
    return refused

  const expected = Buffer.from(sign(payload), 'utf8')
  const offered = Buffer.from(signature, 'utf8')
  if (expected.length !== offered.length || !timingSafeEqual(expected, offered))
    return refused

  let grant: CliGrant
  try {
    grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  }
  catch {
    return refused
  }

  if (!Number.isInteger(grant?.userId) || grant.userId <= 0 || !isChallenge(grant.challenge))
    return refused

  if (!Number.isFinite(grant.expiresAtMs) || grant.expiresAtMs <= nowMs)
    return refused

  const proof = Buffer.from(challengeFor(verifier), 'utf8')
  const wanted = Buffer.from(grant.challenge, 'utf8')
  if (proof.length !== wanted.length || !timingSafeEqual(proof, wanted))
    return refused

  return { ok: true, grant: { ...grant, device: deviceName(grant.device) } }
}

/**
 * What a signed-in command line can do: what its commands need, on every
 * repository the account can reach, and nothing about organizations or the
 * instance.
 *
 * Write on each repository scope and admin on none. The CLI opens pull
 * requests, reviews, pushes and starts workflow runs; it has no command that
 * transfers or deletes a repository, so its token cannot either. Somebody who
 * wants less issues a narrower token on the settings page and passes it with
 * `reviewos login --token`.
 */
export const CLI_TOKEN_PERMISSIONS: readonly { scope: string, level: string }[]
  = REPOSITORY_SCOPES.map(scope => ({ scope, level: 'write' }))

export function cliTokenName(device: string): string {
  return `ReviewOS CLI on ${deviceName(device)}`
}
