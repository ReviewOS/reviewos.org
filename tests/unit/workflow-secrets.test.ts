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
