import { describe, expect, it } from 'bun:test'
import { cloneUrl, cloneUrlFor, originFor } from '../../app/Actions/Repo/cloneUrl'

/**
 * The URL somebody clones with.
 *
 * The thing that keeps going wrong here is deriving it from configuration: an
 * instance behind a proxy, on a second domain, or on a developer's port then
 * shows a URL that does not connect, and the person reading it has no way to
 * know which half is wrong. The request already carries the answer.
 */

describe('originFor', () => {
  it('prefers the request URL, which is the only source carrying the scheme', () => {
    expect(originFor({ url: 'https://code.example.com/anna/checkout', host: 'internal:8080' }))
      .toBe('https://code.example.com')
  })

  it('keeps the port, which is the whole problem on a developer machine', () => {
    expect(originFor({ url: 'http://127.0.0.1:3012/anna/checkout' })).toBe('http://127.0.0.1:3012')
    expect(originFor({ host: '127.0.0.1:3012' })).toBe('http://127.0.0.1:3012')
  })

  /**
   * Assuming HTTPS from a Host header alone produces a URL that fails to
   * connect on every development machine. Assuming HTTP is wrong in production
   * and wrong visibly, which is the better way to be wrong.
   */
  it('assumes plain HTTP when only the host is known', () => {
    expect(originFor({ host: 'code.example.com' })).toBe('http://code.example.com')
  })

  it('falls back to configuration only when there is no request', () => {
    expect(originFor(null, 'https://code.example.com')).toBe('https://code.example.com')
    expect(originFor(undefined, 'https://code.example.com')).toBe('https://code.example.com')
    expect(originFor({}, 'https://code.example.com')).toBe('https://code.example.com')
  })

  /** `APP_URL` ships as a bare host, and a bare host is not a URL. */
  it('accepts a configured value with no scheme on it', () => {
    expect(originFor(null, 'reviewos.localhost')).toBe('https://reviewos.localhost')
  })

  it('has an answer when nothing at all is known', () => {
    expect(originFor(null, null)).toBe('http://localhost')
    expect(originFor(null, '')).toBe('http://localhost')
    expect(originFor(null, '   ')).toBe('http://localhost')
  })

  /** A file URL parses fine and is not somewhere anyone can clone from. */
  it('ignores a URL nobody could clone over', () => {
    expect(originFor({ url: 'file:///etc/passwd' }, 'https://code.example.com'))
      .toBe('https://code.example.com')
    expect(originFor({ url: 'not a url at all' }, 'https://code.example.com'))
      .toBe('https://code.example.com')
  })
})

describe('cloneUrl', () => {
  it('ends in .git, because that is where the wire protocol is served', () => {
    expect(cloneUrl('https://code.example.com', 'anna', 'checkout'))
      .toBe('https://code.example.com/anna/checkout.git')
  })

  it('does not double the slash when the origin carries one', () => {
    expect(cloneUrl('https://code.example.com/', 'anna', 'checkout'))
      .toBe('https://code.example.com/anna/checkout.git')
  })
})

describe('cloneUrlFor', () => {
  it('is the whole thing: a request in, a URL out', () => {
    expect(cloneUrlFor({ url: 'http://127.0.0.1:3012/anna/checkout' }, 'anna', 'checkout'))
      .toBe('http://127.0.0.1:3012/anna/checkout.git')
  })

  it('is still a URL when the page was rendered with no request behind it', () => {
    expect(cloneUrlFor(null, 'anna', 'checkout', 'https://code.example.com'))
      .toBe('https://code.example.com/anna/checkout.git')
  })
})
