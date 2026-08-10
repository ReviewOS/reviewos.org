/**
 * Checking the configuration before the instance serves anything.
 *
 * The failures these describe are the expensive kind: a value wrong in a way
 * nothing notices until the code path that reads it runs. A short `APP_KEY`
 * surfaces as sessions that will not persist. A `DB_PORT` with a stray space
 * surfaces as a connection refused. An unset mail host surfaces the first time
 * a stranger tries to reset a password, a fortnight later.
 *
 * The check takes an environment rather than reading `process.env`, which is
 * the only reason this file can exist: setting a variable in the test runner's
 * own process leaks between tests and cannot reliably be undone.
 */

import { describe as report, inspect } from '../../app/Ops/config'
import { describe, expect, it } from 'bun:test'

/** A configuration with nothing wrong with it. */
const sound = {
  APP_KEY: 'a'.repeat(48),
  APP_URL: 'reviewos.example',
  APP_ENV: 'production',
  DB_CONNECTION: 'postgres',
  DB_DATABASE: 'reviewos',
  DB_USERNAME: 'postgres',
  DB_PORT: '5432',
  MAIL_HOST: 'smtp.example',
}

const fatal = (env: Record<string, string | undefined>) =>
  inspect(env).findings.filter(finding => finding.severity === 'fatal').map(finding => finding.variable)

const warnings = (env: Record<string, string | undefined>) =>
  inspect(env).findings.filter(finding => finding.severity === 'warning').map(finding => finding.variable)

describe('a sound configuration', () => {
  it('passes', () => {
    expect(inspect(sound)).toEqual({ ok: true, findings: [] })
  })
})

describe('the application key', () => {
  it('is fatal in production when absent', () => {
    expect(fatal({ ...sound, APP_KEY: '' })).toContain('APP_KEY')
  })

  it('is only a warning in development', () => {
    /*
     * A developer running with no key has made a reasonable choice. Refusing to
     * start over it would teach people to bypass this check, and a check people
     * bypass is worse than none.
     */
    const verdict = inspect({ ...sound, APP_KEY: '', APP_ENV: 'development' })

    expect(verdict.ok).toBe(true)
    expect(warnings({ ...sound, APP_KEY: '', APP_ENV: 'development' })).toContain('APP_KEY')
  })

  it('is fatal everywhere when it is too short', () => {
    // A truncated key is worse than none: it looks configured.
    expect(fatal({ ...sound, APP_KEY: 'short', APP_ENV: 'development' })).toContain('APP_KEY')
  })
})

describe('the database', () => {
  it('refuses to start without one', () => {
    expect(fatal({ ...sound, DB_DATABASE: '' })).toContain('DB_DATABASE')
  })

  it('catches a port that is not a number', () => {
    /*
     * The stray-space case, which is the whole reason this rule exists: it
     * surfaces as a connection refused at the first request, which sends
     * somebody to look at the network.
     */
    expect(fatal({ ...sound, DB_PORT: '5432 ' })).not.toContain('DB_PORT')
    expect(fatal({ ...sound, DB_PORT: '"5432"' })).toContain('DB_PORT')
  })
})

describe('the instance URL', () => {
  it('accepts a bare host, which is this framework\'s convention', () => {
    // `config.app.url` is used as a domain in most places, and this project's
    // own default has no scheme. Requiring one would flag every correctly
    // configured instance.
    expect(inspect({ ...sound, APP_URL: 'reviewos.example' }).ok).toBe(true)
    expect(warnings({ ...sound, APP_URL: 'reviewos.example' })).toEqual([])
  })

  it('and a scheme, because plenty of people will write one', () => {
    expect(warnings({ ...sound, APP_URL: 'https://reviewos.example' })).toEqual([])
  })

  it('warns about a pasted browser URL', () => {
    // A path here appears twice in every generated link.
    expect(warnings({ ...sound, APP_URL: 'https://reviewos.example/acme/api' })).toContain('APP_URL')
  })

  it('warns about a trailing slash', () => {
    expect(warnings({ ...sound, APP_URL: 'https://reviewos.example/' })).toContain('APP_URL')
  })

  it('warns about plain http in production, but not on localhost', () => {
    /*
     * Every token and session cookie crosses the network in the clear. A local
     * instance is not doing that, and warning about it would be noise on every
     * development machine.
     */
    expect(warnings({ ...sound, APP_URL: 'http://reviewos.example' })).toContain('APP_URL')
    expect(warnings({ ...sound, APP_URL: 'http://localhost:3000' })).toEqual([])
  })
})

describe('error reporting', () => {
  it('says nothing when it is off, which is the default', () => {
    expect(warnings(sound)).toEqual([])
  })

  it('warns about an address with no scheme rather than half-enabling it', () => {
    /*
     * Reporting is off in that case rather than half on, and the point of
     * saying so at boot is that the alternative is discovering it on the day
     * something breaks - by somebody already having a bad time who now has no
     * report either.
     */
    expect(warnings({ ...sound, ERROR_REPORTING_URL: 'collector.example/hook' })).toContain('ERROR_REPORTING_URL')
  })

  it('and about sending reports over plain http', () => {
    // Redaction removes credentials, not the shape of your instance.
    expect(warnings({ ...sound, ERROR_REPORTING_URL: 'http://collector.example/hook' })).toContain('ERROR_REPORTING_URL')
  })

  it('but not about a local collector', () => {
    expect(warnings({ ...sound, ERROR_REPORTING_URL: 'http://localhost:9000/hook' })).toEqual([])
  })

  it('and not about a correctly configured one', () => {
    expect(warnings({ ...sound, ERROR_REPORTING_URL: 'https://collector.example/hook' })).toEqual([])
  })
})

describe('mail', () => {
  it('is a warning rather than fatal', () => {
    /*
     * An instance with no mail is a reasonable private deployment. But somebody
     * should know, because password resets and review notifications both go out
     * this way and their absence is silent.
     */
    const env = { ...sound, MAIL_HOST: '' }

    expect(inspect(env).ok).toBe(true)
    expect(warnings(env)).toContain('MAIL_HOST')
  })
})

describe('what it prints', () => {
  it('names the variable and what to do about it', () => {
    // The variable is what somebody greps their .env for; the fix is the part
    // they act on.
    const text = report(inspect({ ...sound, APP_KEY: '' }))

    expect(text).toContain('APP_KEY')
    expect(text).toContain('key:generate')
  })

  it('and says so plainly when there is nothing to say', () => {
    expect(report(inspect(sound))).toBe('Configuration looks fine.')
  })
})

describe('the idle-session limit', () => {
  it('is fine when absent, which is the default', () => {
    // No limit is a legitimate choice, and the common one for a self-hosted
    // instance on somebody's own hardware.
    expect(inspect({}).findings.some(one => one.variable === 'AUTH_IDLE_TIMEOUT')).toBe(false)
  })

  it('a value that is not a number is fatal', () => {
    /*
     * `AUTH_IDLE_TIMEOUT=30m` coerces to `NaN` and then to "off", so the
     * instance starts with a hardening control that reads as configured and
     * does nothing. That is the failure this whole file exists to prevent.
     */
    const finding = inspect({ AUTH_IDLE_TIMEOUT: '30m' }).findings.find(one => one.variable === 'AUTH_IDLE_TIMEOUT')

    expect(finding?.severity).toBe('fatal')
    expect(finding?.fix).toContain('milliseconds')
  })

  it('seconds where milliseconds were meant is warned about', () => {
    // 1800 reads as "thirty minutes" to whoever typed it and means under two
    // seconds, which presents as everybody being signed out constantly - a
    // symptom nobody connects to a setting.
    const finding = inspect({ AUTH_IDLE_TIMEOUT: '1800' }).findings.find(one => one.variable === 'AUTH_IDLE_TIMEOUT')

    expect(finding?.severity).toBe('warning')
    expect(finding?.problem).toContain('2 seconds')
  })

  it('a real half-hour passes without comment', () => {
    expect(inspect({ AUTH_IDLE_TIMEOUT: '1800000' }).findings.some(one => one.variable === 'AUTH_IDLE_TIMEOUT')).toBe(false)
  })
})
