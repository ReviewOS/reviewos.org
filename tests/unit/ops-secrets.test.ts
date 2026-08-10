// Secrets read from a file rather than from the environment.
//
// The rules worth pinning are the three that fail quietly. A trailing newline
// on a password authenticates against nothing while looking correct wherever it
// is printed; an environment value silently losing to a file makes a one-off
// override do nothing; and a secret file that did not mount reads downstream as
// a variable somebody forgot to set, which sends them to fix the wrong thing.

import { describe, expect, test } from 'bun:test'
import { inspect } from '../../app/Ops/config'
import { resolveSecretFiles } from '../../app/Ops/secrets'

/** A reader over a fixed set of paths, so no test touches a real filesystem. */
function reader(files: Record<string, string>) {
  return (path: string) => {
    if (!(path in files)) {
      const error: any = new Error(`ENOENT: no such file or directory, open '${path}'`)
      error.code = 'ENOENT'
      throw error
    }

    return files[path]!
  }
}

describe('resolving secret files', () => {
  test('fills in the variable from the file it names', () => {
    const env: Record<string, string | undefined> = { DB_PASSWORD_FILE: '/run/secrets/db' }
    const result = resolveSecretFiles(env, reader({ '/run/secrets/db': 'hunter2' }))

    expect(env.DB_PASSWORD).toBe('hunter2')
    expect(result.resolved).toEqual(['DB_PASSWORD'])
    expect(result.problems).toEqual([])
  })

  test('strips the trailing newline every editor adds', () => {
    /*
     * The failure this prevents is a genuinely miserable hour: a password with
     * a newline on the end fails to authenticate against a server that is
     * otherwise configured perfectly, and the value looks right everywhere it
     * is printed.
     */
    const env: Record<string, string | undefined> = { DB_PASSWORD_FILE: '/s' }
    resolveSecretFiles(env, reader({ '/s': 'hunter2\n' }))

    expect(env.DB_PASSWORD).toBe('hunter2')
  })

  test('does not strip a leading space, which could be part of the secret', () => {
    const env: Record<string, string | undefined> = { DB_PASSWORD_FILE: '/s' }
    resolveSecretFiles(env, reader({ '/s': ' hunter2\n' }))

    expect(env.DB_PASSWORD).toBe(' hunter2')
  })

  test('an environment value already set wins over the file', () => {
    // The usual reason both exist is somebody overriding a mounted secret for
    // one run. Making the file win would make that override silently do
    // nothing, so the operator tests a different credential from the one they
    // think they are testing.
    const env: Record<string, string | undefined> = { DB_PASSWORD: 'from-env', DB_PASSWORD_FILE: '/s' }
    const result = resolveSecretFiles(env, reader({ '/s': 'from-file' }))

    expect(env.DB_PASSWORD).toBe('from-env')
    expect(result.resolved).toEqual([])
  })

  test('a file that does not exist is a problem, not an exception', () => {
    const env: Record<string, string | undefined> = { DB_PASSWORD_FILE: '/run/secrets/db' }
    const result = resolveSecretFiles(env, reader({}))

    expect(env.DB_PASSWORD).toBeUndefined()
    expect(result.problems).toEqual([
      { variable: 'DB_PASSWORD', file: '/run/secrets/db', problem: 'does not exist' },
    ])
  })

  test('an empty file is a problem rather than an empty password', () => {
    // An empty secret is always a mount that produced nothing, and accepting it
    // would turn a missing credential into an authentication failure somewhere
    // far away from the cause.
    const env: Record<string, string | undefined> = { DB_PASSWORD_FILE: '/s' }
    const result = resolveSecretFiles(env, reader({ '/s': '\n' }))

    expect(env.DB_PASSWORD).toBeUndefined()
    expect(result.problems[0]?.problem).toBe('is empty')
  })

  test('a blank path is left alone', () => {
    // A compose file with an unset variable produces `NAME_FILE=`, and that is
    // "not using this", not "read the file called nothing".
    const env: Record<string, string | undefined> = { DB_PASSWORD_FILE: '' }
    const result = resolveSecretFiles(env, reader({}))

    expect(result.problems).toEqual([])
    expect(result.resolved).toEqual([])
  })

  test('anything ending in _FILE works, not a fixed list', () => {
    // A fixed list is a list somebody has to remember to add to, and the one
    // they forget is the one an operator needed.
    const env: Record<string, string | undefined> = {
      APP_KEY_FILE: '/a',
      MAIL_PASSWORD_FILE: '/b',
      SOMETHING_NOBODY_ANTICIPATED_FILE: '/c',
    }

    resolveSecretFiles(env, reader({ '/a': 'k', '/b': 'm', '/c': 's' }))

    expect(env.APP_KEY).toBe('k')
    expect(env.MAIL_PASSWORD).toBe('m')
    expect(env.SOMETHING_NOBODY_ANTICIPATED).toBe('s')
  })
})

describe('the boot check', () => {
  test('reports the file, not the variable, when a mount failed', () => {
    /*
     * The whole reason the resolution is reported to `inspect` rather than done
     * quietly. Without it the operator is told `DB_PASSWORD` is not set, and
     * setting `DB_PASSWORD` is exactly the wrong response to a secret that did
     * not mount.
     */
    const env: Record<string, string | undefined> = { DB_PASSWORD_FILE: '/run/secrets/db' }
    const secrets = resolveSecretFiles(env, reader({}))
    const verdict = inspect(env, { production: true, secrets })

    expect(verdict.ok).toBe(false)

    const finding = verdict.findings.find(one => one.variable === 'DB_PASSWORD_FILE')
    expect(finding?.severity).toBe('fatal')
    expect(finding?.problem).toContain('/run/secrets/db')

    // First, because everything else is downstream of it.
    expect(verdict.findings[0]?.variable).toBe('DB_PASSWORD_FILE')
  })

  test('a resolved secret satisfies the rule that wanted the variable', () => {
    const env: Record<string, string | undefined> = {
      APP_ENV: 'production',
      APP_KEY_FILE: '/k',
    }

    const secrets = resolveSecretFiles(env, reader({ '/k': 'x'.repeat(48) }))

    expect(inspect(env, { secrets }).findings.some(one => one.variable === 'APP_KEY')).toBe(false)
  })
})
