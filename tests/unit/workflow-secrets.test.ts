// Which secrets a job may see.
//
// The rest of the feature is storage and plumbing; this is the part where being
// wrong hands a credential to code that should not have it. Three rules, and
// each one is a thing somebody could reasonably have implemented differently:
// a fork gets nothing, an environment's secrets need the gate to have opened,
// and narrowest wins.

import { describe, expect, test } from 'bun:test'
import { SECRET_PRECEDENCE, selectSecrets } from '../../app/Actions/Workflow/secrets'

function row(over: Partial<{ key: string, scope: any, scopeId: number, sealed: string }> = {}): any {
  return { key: 'DEPLOY_TOKEN', scope: 'repository', scopeId: 1, sealed: 'sealed', ...over }
}

const TRUSTED = { trusted: true, environment: null, environmentId: null, approved: false }

describe('a fork', () => {
  test('gets nothing at all, whatever is set', () => {
    /*
     * Checked before every other rule, because the others are about *which*
     * secrets and this one is about whether the question is being asked by
     * code the repository wrote.
     */
    const chosen = selectSecrets({
      rows: [row(), row({ key: 'NPM_TOKEN', scope: 'instance', scopeId: 0 })],
      trusted: false,
      environment: 'production',
      environmentId: 4,
      approved: true,
    })

    expect(chosen).toEqual([])
  })
})

describe('an environment\'s secrets', () => {
  const rows = [
    row({ key: 'DEPLOY_TOKEN', scope: 'repository', scopeId: 1 }),
    row({ key: 'DEPLOY_TOKEN', scope: 'environment', scopeId: 4, sealed: 'production' }),
  ]

  test('are withheld from a job that is not deploying to it', () => {
    // The build job in the same run. This is the separation a repository-wide
    // secret cannot express however carefully somebody names it.
    const chosen = selectSecrets({ rows, ...TRUSTED })

    expect(chosen).toHaveLength(1)
    expect(chosen[0]!.scope).toBe('repository')
  })

  test('and from the deploy job until its gate has opened', () => {
    /*
     * "Released only after protection passes" is this line. Without it the
     * deploy credential sits in the job's environment while it waits for a
     * reviewer, which is the window somebody would use.
     */
    const waiting = selectSecrets({ rows, trusted: true, environment: 'production', environmentId: 4, approved: false })

    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.scope).toBe('repository')
  })

  test('and beat the repository once it has', () => {
    const approved = selectSecrets({ rows, trusted: true, environment: 'production', environmentId: 4, approved: true })

    expect(approved).toHaveLength(1)
    expect(approved[0]!.scope).toBe('environment')
    expect(approved[0]!.sealed).toBe('production')
  })

  test('and another environment\'s never apply', () => {
    // Same job, different environment id: staging's credential must not reach
    // a production deploy because both rows are "an environment secret".
    const chosen = selectSecrets({
      rows: [row({ key: 'DEPLOY_TOKEN', scope: 'environment', scopeId: 9 })],
      trusted: true,
      environment: 'production',
      environmentId: 4,
      approved: true,
    })

    expect(chosen).toEqual([])
  })
})

describe('precedence', () => {
  test('narrowest wins, and an environment is the narrowest of all', () => {
    expect(SECRET_PRECEDENCE.environment).toBeGreaterThan(SECRET_PRECEDENCE.repository)
    expect(SECRET_PRECEDENCE.repository).toBeGreaterThan(SECRET_PRECEDENCE.owner)
    expect(SECRET_PRECEDENCE.owner).toBeGreaterThan(SECRET_PRECEDENCE.instance)
  })

  test('one key set at three levels resolves to one secret', () => {
    const chosen = selectSecrets({
      rows: [
        row({ key: 'NPM_TOKEN', scope: 'instance', scopeId: 0, sealed: 'instance' }),
        row({ key: 'NPM_TOKEN', scope: 'owner', scopeId: 2, sealed: 'owner' }),
        row({ key: 'NPM_TOKEN', scope: 'repository', scopeId: 1, sealed: 'repository' }),
      ],
      ...TRUSTED,
    })

    expect(chosen).toHaveLength(1)
    expect(chosen[0]!.sealed).toBe('repository')
  })

  test('and the input order does not decide it', () => {
    const rows = [
      row({ key: 'NPM_TOKEN', scope: 'repository', scopeId: 1, sealed: 'repository' }),
      row({ key: 'NPM_TOKEN', scope: 'instance', scopeId: 0, sealed: 'instance' }),
    ]

    expect(selectSecrets({ rows, ...TRUSTED })[0]!.sealed).toBe('repository')
    expect(selectSecrets({ rows: [...rows].reverse(), ...TRUSTED })[0]!.sealed).toBe('repository')
  })
})

describe('a job that names what it needs', () => {
  const rows = [
    row({ key: 'DEPLOY_KEY' }),
    row({ key: 'NPM_TOKEN' }),
    row({ key: 'SENTRY_DSN' }),
  ]

  test('gets those and no others', () => {
    /*
     * Least privilege, per job. Without it a test job holds the deploy key for
     * the length of its run, and a compromised dependency in that job reads a
     * credential the job never needed - which is the supply-chain shape this
     * whole phase is written against.
     */
    const chosen = selectSecrets({ rows, ...TRUSTED, only: ['NPM_TOKEN'] })

    expect(chosen.map(one => one.key)).toEqual(['NPM_TOKEN'])
  })

  test('naming one that does not exist gets nothing extra, and is not an error', () => {
    // The same workflow file runs on a clone and on an instance where somebody
    // has not set the secret yet. A missing secret is a fact about the store,
    // not a mistake in the file.
    expect(selectSecrets({ rows, ...TRUSTED, only: ['NOT_SET'] })).toEqual([])
  })

  test('an empty list means none, which is not what saying nothing means', () => {
    /*
     * `secrets: []` is a job that has decided; a job that says nothing has not.
     * Reading the two the same way would either break every workflow written
     * before this existed or silently ignore somebody asking for a job with no
     * credentials at all.
     */
    expect(selectSecrets({ rows, ...TRUSTED, only: [] })).toEqual([])
    expect(selectSecrets({ rows, ...TRUSTED, only: null }).map(one => one.key)).toEqual([
      'DEPLOY_KEY', 'NPM_TOKEN', 'SENTRY_DSN',
    ])
    expect(selectSecrets({ rows, ...TRUSTED }).map(one => one.key)).toHaveLength(3)
  })

  test('and naming a secret does not get a fork one', () => {
    // The fork rule is answered before this one, and asking by name must not be
    // a way around it.
    expect(selectSecrets({ rows, ...TRUSTED, trusted: false, only: ['DEPLOY_KEY'] })).toEqual([])
  })

  test('nor one whose environment gate has not opened', () => {
    const gated = [row({ key: 'PROD_KEY', scope: 'environment', scopeId: 9 })]

    expect(selectSecrets({
      rows: gated,
      trusted: true,
      environment: 'production',
      environmentId: 9,
      approved: false,
      only: ['PROD_KEY'],
    })).toEqual([])

    expect(selectSecrets({
      rows: gated,
      trusted: true,
      environment: 'production',
      environmentId: 9,
      approved: true,
      only: ['PROD_KEY'],
    }).map(one => one.key)).toEqual(['PROD_KEY'])
  })
})
