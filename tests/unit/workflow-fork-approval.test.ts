// Whether a fork's pull request runs without somebody saying so.
//
// The fork policy's last clause, and the one every forge has been breached over.
// A pull request from a fork already gets no secrets and no identity token and
// cannot supply the workflow it runs under - and it still spends the fleet, and
// still reaches whatever those machines reach.
//
// Pure, because the rule is the part that has to be readable: a policy that
// could only be exercised by dispatching a run is one nobody would test the
// awkward cases of, and the awkward cases are the whole feature.

import { describe, expect, test } from 'bun:test'
import { forkApprovalVerdict } from '../../app/Actions/Workflow/forkApproval'

function facts(over: Partial<Parameters<typeof forkApprovalVerdict>[0]> = {}) {
  return {
    policy: 'first-time' as const,
    trusted: false,
    contributedBefore: false,
    collaborator: false,
    ...over,
  }
}

describe('a run of the repository\'s own code', () => {
  test('never waits, whatever the policy says', () => {
    for (const policy of ['first-time', 'always', 'never'] as const)
      expect(forkApprovalVerdict(facts({ policy, trusted: true })).required).toBe(false)
  })
})

describe('the default, `first-time`', () => {
  test('asks about somebody whose work has never landed here', () => {
    const verdict = forkApprovalVerdict(facts())

    expect(verdict.required).toBe(true)
    expect(verdict.reason).toContain('first-time')
  })

  test('and stops asking once it has', () => {
    /*
     * The fact the setting is actually about: somebody whose pull request has
     * been merged here was vouched for by a person with write access once
     * already.
     */
    expect(forkApprovalVerdict(facts({ contributedBefore: true })).required).toBe(false)
  })
})

describe('`always`', () => {
  test('asks about everybody, including a second-time contributor', () => {
    expect(forkApprovalVerdict(facts({ policy: 'always', contributedBefore: true })).required).toBe(true)
  })
})

describe('`never`', () => {
  test('is the behaviour of an instance that has not thought about this', () => {
    expect(forkApprovalVerdict(facts({ policy: 'never' })).required).toBe(false)
  })
})

describe('a collaborator\'s fork', () => {
  test('is not asked about, because a push from them would run without asking', () => {
    /*
     * Still an untrusted run - the code is somebody else's branch, and it stays
     * untrusted for secrets and identity - but asking its author for permission
     * to run it is theatre when they could push to this repository instead.
     */
    const verdict = forkApprovalVerdict(facts({ policy: 'always', collaborator: true }))

    expect(verdict.required).toBe(false)
    expect(verdict.reason).toContain('can push here')
  })
})
