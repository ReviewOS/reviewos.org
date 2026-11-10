import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CLI_GRANT_LIFETIME_MS, CLI_TOKEN_PERMISSIONS, challengeFor, cliTokenName, deviceName, isChallenge, loopbackPort, loopbackUrl, openCliGrant, sealCliGrant } from '../../app/Actions/Tokens/cliLogin'
import { approvalUrl, listen, newAttempt, openerFor, readCallback } from '../../app/Cli/browserLogin'
import { REPOSITORY_SCOPES } from '../../app/TokenScopes'

/**
 * Signing the command line in through the browser.
 *
 * The rules that make it safe are small and each has a line here: a code is
 * worth nothing without the verifier, it stops working after two minutes, it
 * cannot be altered, and it can only ever be sent to 127.0.0.1.
 */
describe('an approval, as the server signs it', () => {
  const now = 1_800_000_000_000
  const attempt = newAttempt('workstation.local')
  const code = sealCliGrant({ userId: 7, challenge: attempt.challenge, device: attempt.device, nowMs: now })

  it('opens for the terminal that asked, and names who approved', () => {
    const opened = openCliGrant(code, attempt.verifier, now + 1000)
    expect(opened).toEqual({ ok: true, grant: { userId: 7, challenge: attempt.challenge, device: 'workstation', expiresAtMs: now + CLI_GRANT_LIFETIME_MS } })
  })

  it('is worth nothing to anybody who only saw the code', () => {
    expect(openCliGrant(code, newAttempt().verifier, now + 1000).ok).toBe(false)
    expect(openCliGrant(code, '', now + 1000).ok).toBe(false)
    expect(openCliGrant(code, undefined, now + 1000).ok).toBe(false)
  })

  it('stops working after two minutes', () => {
    expect(openCliGrant(code, attempt.verifier, now + CLI_GRANT_LIFETIME_MS - 1).ok).toBe(true)
    expect(openCliGrant(code, attempt.verifier, now + CLI_GRANT_LIFETIME_MS).ok).toBe(false)
  })

  it('cannot be rewritten into another account or a longer life', () => {
    const [payload, signature] = code.split('.') as [string, string]
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const forged = (change: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ ...grant, ...change })).toString('base64url')}.${signature}`

    expect(openCliGrant(forged({ userId: 1 }), attempt.verifier, now).ok).toBe(false)
    expect(openCliGrant(forged({ expiresAtMs: now * 2 }), attempt.verifier, now).ok).toBe(false)
    expect(openCliGrant(payload, attempt.verifier, now).ok).toBe(false)
    expect(openCliGrant(`${payload}.${signature}.extra`, attempt.verifier, now).ok).toBe(false)
    expect(openCliGrant('not a code', attempt.verifier, now).ok).toBe(false)
  })

  it('says the same thing however a code is wrong', () => {
    const wrongVerifier = openCliGrant(code, newAttempt().verifier, now)
    const expired = openCliGrant(code, attempt.verifier, now + CLI_GRANT_LIFETIME_MS)
    expect(wrongVerifier.ok === false && expired.ok === false && wrongVerifier.error === expired.error).toBe(true)
  })
})

describe('where a code may be sent', () => {
  it('only to this machine, on a port a program can hold without privileges', () => {
    expect(loopbackPort('49152')).toBe(49152)
    for (const refused of ['80', '0', '-1', '65536', '8080.5', 'evil.example', '', undefined, '8080@evil.example'])
      expect(loopbackPort(refused)).toBeNull()

    const url = new URL(loopbackUrl(49152, { code: 'a.b', state: 's' }))
    expect(url.origin).toBe('http://127.0.0.1:49152')
    expect(url.pathname).toBe('/callback')
    expect(url.searchParams.get('code')).toBe('a.b')
  })

  it('recognises a challenge and nothing else as one', () => {
    expect(isChallenge(challengeFor('anything'))).toBe(true)
    expect(isChallenge('short')).toBe(false)
    expect(isChallenge(`${challengeFor('anything')}"><script>`)).toBe(false)
  })

  it('shows a machine name as text', () => {
    expect(deviceName('Chris MacBook Pro (work)')).toBe('Chris MacBook Pro (work)')
    expect(deviceName('<img src=x onerror=alert(1)>')).toBe('img srcx onerroralert(1)')
    expect(deviceName('')).toBe('a terminal')
    expect(deviceName('x'.repeat(200))).toHaveLength(60)
    expect(cliTokenName('workstation')).toBe('ReviewOS CLI on workstation')
  })
})

describe('what a signed-in command line can do', () => {
  it('writes on every repository scope and administers none', () => {
    expect(CLI_TOKEN_PERMISSIONS.map(grant => grant.scope).sort()).toEqual([...REPOSITORY_SCOPES].sort())
    expect(CLI_TOKEN_PERMISSIONS.every(grant => grant.level === 'write')).toBe(true)
  })
})

describe('the terminal\'s side', () => {
  it('asks with a challenge, never with the verifier', () => {
    const attempt = newAttempt('host.local')
    const url = new URL(approvalUrl('https://reviewos.example', attempt, 50123))

    expect(url.origin + url.pathname).toBe('https://reviewos.example/cli/login')
    expect(url.searchParams.get('challenge')).toBe(challengeFor(attempt.verifier))
    expect(url.searchParams.get('port')).toBe('50123')
    expect(url.searchParams.get('device')).toBe('host')
    expect(url.href).not.toContain(attempt.verifier)
    // Without a listener the page shows a code to paste instead of redirecting.
    expect(new URL(approvalUrl('https://reviewos.example/', attempt)).searchParams.has('port')).toBe(false)
  })

  it('ignores a callback that is not for this attempt', () => {
    const attempt = newAttempt()
    expect(readCallback(`http://127.0.0.1:1/callback?code=x&state=${attempt.state}`, attempt)).toEqual({ kind: 'code', code: 'x' })
    expect(readCallback(`http://127.0.0.1:1/callback?error=denied&state=${attempt.state}`, attempt)).toEqual({ kind: 'denied' })
    expect(readCallback('http://127.0.0.1:1/callback?code=x&state=somebody-else', attempt)).toEqual({ kind: 'ignored' })
    expect(readCallback(`http://127.0.0.1:1/other?code=x&state=${attempt.state}`, attempt)).toEqual({ kind: 'ignored' })
    expect(readCallback(`http://127.0.0.1:1/callback?state=${attempt.state}`, attempt)).toEqual({ kind: 'ignored' })
  })

  it('hears the browser come back, and is not ended by a stray request', async () => {
    const attempt = newAttempt()
    const listener = listen(attempt, 5000)
    try {
      const stray = await fetch(`http://127.0.0.1:${listener.port}/callback?code=x&state=guess`)
      expect(stray.status).toBe(404)

      const back = await fetch(`http://127.0.0.1:${listener.port}/callback?code=the-code&state=${attempt.state}`)
      expect(back.status).toBe(200)
      expect(await back.text()).toContain('Signed in')
      expect(await listener.answer).toEqual({ kind: 'code', code: 'the-code' })
    }
    finally { listener.stop() }
  })

  it('gives up when nobody answers', async () => {
    const listener = listen(newAttempt(), 20)
    try { expect(await listener.answer).toBeNull() }
    finally { listener.stop() }
  })

  it('opens the browser the way each platform does', () => {
    expect(openerFor('darwin')).toEqual(['open'])
    expect(openerFor('linux')).toEqual(['xdg-open'])
    expect(openerFor('win32')[0]).toBe('cmd')
  })
})

describe('the two ends agree', () => {
  it('a code the server signs for the terminal\'s challenge opens with the terminal\'s verifier', () => {
    const attempt = newAttempt()
    const code = sealCliGrant({ userId: 3, challenge: new URL(approvalUrl('https://r.example', attempt)).searchParams.get('challenge')!, device: attempt.device })
    expect(openCliGrant(code, attempt.verifier).ok).toBe(true)
  })

  it('approving takes a browser session, and the exchange takes none', () => {
    const routes = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8')
    expect(routes).toContain(`route.post('/cli/login/approve', 'Actions/Tokens/ApproveCliLoginAction').middleware('auth')`)
    expect(routes).toMatch(/route\.post\('\/cli\/login\/token', 'Actions\/Tokens\/ExchangeCliLoginAction'\)\.skipCsrf\(\)\.middleware\('throttle:/)
    // The approval is a browser form, so it keeps the CSRF check the exchange has no cookie for.
    expect(routes).not.toContain(`ApproveCliLoginAction').skipCsrf()`)

    // A token must not be able to approve a sign-in that issues a broader one.
    const approve = readFileSync(new URL('../../app/Actions/Tokens/ApproveCliLoginAction.ts', import.meta.url), 'utf8')
    expect(approve).toContain('__fineGrainedToken')
    expect(approve.indexOf('__fineGrainedToken')).toBeLessThan(approve.indexOf('sealCliGrant({'))
  })
})
