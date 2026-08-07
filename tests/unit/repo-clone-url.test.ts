import { describe, expect, it } from 'bun:test'
import {
  cloneUrl,
  cloneUrlFor,
  DEFAULT_SSH_CLONE_PORT,
  originFor,
  sshCloneUrl,
  sshCloneUrlFor,
  sshEndpointFrom,
} from '../../app/Actions/Repo/cloneUrl'

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

/**
 * SSH, which is offered only when somebody has said it answers.
 *
 * The failure this guards against is not a wrong URL - it is a URL that looks
 * right and connects to nothing. Somebody copies it, waits for a timeout, and
 * concludes the forge is broken rather than that a feature is off.
 */
describe('sshEndpointFrom', () => {
  it('is nothing at all when neither host nor port is set', () => {
    expect(sshEndpointFrom({})).toBeNull()
    expect(sshEndpointFrom({ SSH_CLONE_HOST: '', SSH_PORT: '  ' })).toBeNull()
  })

  it('takes the host from the request when only a port is configured', () => {
    // The daemon runs beside the application, and an operator who set the port
    // has usually not thought about the hostname.
    expect(sshEndpointFrom({ SSH_PORT: '2222' }, { url: 'https://code.example.com/anna/checkout' }))
      .toEqual({ host: 'code.example.com', port: 2222, user: 'git' })
  })

  it('prefers a configured host, which is how a separate SSH hostname works', () => {
    expect(sshEndpointFrom({ SSH_CLONE_HOST: 'ssh.example.com', SSH_PORT: '22' }, { host: 'code.example.com' }))
      .toEqual({ host: 'ssh.example.com', port: 22, user: 'git' })
  })

  it('defaults the port to the one buddy git:ssh binds', () => {
    expect(sshEndpointFrom({ SSH_CLONE_HOST: 'ssh.example.com' })?.port).toBe(DEFAULT_SSH_CLONE_PORT)
  })

  it('refuses a port that is not one', () => {
    expect(sshEndpointFrom({ SSH_PORT: 'no' })).toBeNull()
    expect(sshEndpointFrom({ SSH_PORT: '0' })).toBeNull()
    expect(sshEndpointFrom({ SSH_PORT: '70000' })).toBeNull()
  })

  it('lets the account be changed, though the identity is still the key', () => {
    expect(sshEndpointFrom({ SSH_PORT: '22', SSH_CLONE_USER: 'code' })?.user).toBe('code')
  })
})

describe('sshCloneUrl', () => {
  it('uses the short form on port 22, which is what everybody recognises', () => {
    expect(sshCloneUrl({ host: 'code.example.com', port: 22, user: 'git' }, 'anna', 'checkout'))
      .toBe('git@code.example.com:anna/checkout.git')
  })

  /**
   * The short form has nowhere to put a port: the colon is already the path
   * separator, so `git@host:2222/anna/checkout.git` asks for the repository
   * `2222/anna/checkout.git`. That is a confusing way to fail, and it is the
   * form a forge on a non-standard port gets wrong.
   */
  it('uses the ssh:// form on any other port', () => {
    expect(sshCloneUrl({ host: 'code.example.com', port: 2222, user: 'git' }, 'anna', 'checkout'))
      .toBe('ssh://git@code.example.com:2222/anna/checkout.git')
  })
})

describe('sshCloneUrlFor', () => {
  it('is null when the daemon is not configured, so the box hides the option', () => {
    expect(sshCloneUrlFor({ host: 'code.example.com' }, 'anna', 'checkout', {})).toBeNull()
  })

  it('is a URL when it is', () => {
    expect(sshCloneUrlFor({ url: 'http://127.0.0.1:3012/x' }, 'anna', 'checkout', { SSH_PORT: '2222' }))
      .toBe('ssh://git@127.0.0.1:2222/anna/checkout.git')
  })
})
