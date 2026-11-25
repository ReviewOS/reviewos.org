// Who renders behind everybody else (#19).
//
// A crawler ignoring robots.txt held every render slot, and the whole site
// answered "rendering is busy". Signed-out requests for the spaces robots.txt
// disallows now render in the background class; these pin which requests
// those are, and that a cookie which only looks like a session is not one.

import { afterEach, describe, expect, test } from 'bun:test'
import serverConfig from '../../config/server'
import { CRAWLER_SPACE_RULES, forgetSessions, isCrawlerSpace, rendersInBackground, robotsRule, sessionToken } from '../../app/Actions/Browse/renderPriority'

const COOKIE = 'auth-token'
const live = new Set(['good-token'])
let lookups = 0
const validate = async (token: string) => {
  lookups++
  return live.has(token) ? { id: 1 } : undefined
}
const page = (path: string, headers: Record<string, string> = {}) => new Request(`https://reviewos.test${path}`, { headers })
const background = (request: Request, now?: () => number) => rendersInBackground(request, { validate, cookieName: COOKIE, now })

afterEach(() => {
  forgetSessions()
  lookups = 0
})

describe('crawlable space', () => {
  test('is the wildcard half of the robots list, and only that', () => {
    expect(CRAWLER_SPACE_RULES).toContain('/*/*/tree/')
    expect(CRAWLER_SPACE_RULES).toContain('/*/*/commits')
    expect(CRAWLER_SPACE_RULES).not.toContain('/login')
    expect(CRAWLER_SPACE_RULES.every(rule => rule.includes('*'))).toBe(true)
  })

  test('covers the code browser and leaves the rest of a repository alone', () => {
    for (const path of ['/stacks/WebKit/commits/main/Source/WebCore/rendering/PaintInfo.h', '/o/r/tree/main/src', '/o/r/blob/v1/README.md', '/o/r/commit/abc', '/o/r/compare/a...b'])
      expect(isCrawlerSpace(path), path).toBe(true)

    for (const path of ['/', '/explore', '/login', '/search', '/o/r', '/o/r/issues', '/o/r/pull/3', '/o/r/pulls'])
      expect(isCrawlerSpace(path), path).toBe(false)
  })

  test('cannot be stepped around with a percent-escape', () => {
    expect(isCrawlerSpace('/o/r/%74ree/main')).toBe(true)
  })

  test('reads robots rules the way crawlers do', () => {
    expect(robotsRule('/*/*/tree/').test('/a/b/tree/x')).toBe(true)
    expect(robotsRule('/*/*/tree/').test('/a/b/treex')).toBe(false)
    expect(robotsRule('/a.b$').test('/a.b')).toBe(true)
    expect(robotsRule('/a.b$').test('/axb')).toBe(false)
    expect(robotsRule('/a.b$').test('/a.b/c')).toBe(false)
  })
})

describe('rendersInBackground', () => {
  test('lowers a signed-out visit to crawlable space without asking the database', async () => {
    expect(await background(page('/o/r/tree/main'))).toBe(true)
    expect(lookups).toBe(0)
  })

  test('never lowers anything outside it, signed in or not', async () => {
    expect(await background(page('/o/r/issues'))).toBe(false)
    expect(await background(page('/login', { cookie: `${COOKIE}=forged` }))).toBe(false)
    expect(lookups).toBe(0)
  })

  test('keeps a signed-in person in the foreground, by cookie or bearer', async () => {
    expect(await background(page('/o/r/tree/main', { cookie: `X-CSRF-Token=1; ${COOKIE}=good-token` }))).toBe(false)
    expect(await background(page('/o/r/tree/main', { authorization: 'Bearer good-token' }))).toBe(false)
  })

  test('lowers a cookie that only looks like a session', async () => {
    expect(await background(page('/o/r/tree/main', { cookie: `${COOKIE}=forged` }))).toBe(true)
    expect(await background(page('/o/r/tree/main', { cookie: 'session=x; auth=y' }))).toBe(true)
  })

  test('asks about a forged cookie once a minute, however often it is sent', async () => {
    let now = 0
    for (let i = 0; i < 50; i++)
      await background(page('/o/r/tree/main', { cookie: `${COOKIE}=forged` }), () => now)
    expect(lookups).toBe(1)

    now += 61_000
    await background(page('/o/r/tree/main', { cookie: `${COOKIE}=forged` }), () => now)
    expect(lookups).toBe(2)
  })

  test('treats a lookup that throws as signed out', async () => {
    const request = page('/o/r/tree/main', { cookie: `${COOKIE}=good-token` })
    expect(await rendersInBackground(request, { cookieName: COOKIE, validate: async () => { throw new Error('db down') } })).toBe(true)
  })
})

test('sessionToken reads the named cookie and nothing else', () => {
  expect(sessionToken(page('/', { cookie: `a=1; ${COOKIE}=t%3D1; b=2` }), COOKIE)).toBe('t=1')
  expect(sessionToken(page('/', { cookie: `x${COOKIE}=nope` }), COOKIE)).toBeNull()
})

test('config/server.ts sends this rule to the page server, one slot and a long Retry-After', async () => {
  const background = (serverConfig as any).render.background

  expect(background.concurrency).toBe(1)
  expect(background.retryAfterSeconds).toBeGreaterThanOrEqual(30)
  expect(await background.match(page('/o/r/tree/main'))).toBe(true)
  expect(await background.match(page('/o/r/issues'))).toBe(false)
})
