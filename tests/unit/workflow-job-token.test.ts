// The automatic token a job talks to the API with.
//
// `permissions:` has been parsed, stored and shown on the run screen since the
// beginning and acted on by nothing - the same defect as `fail-fast` and
// `timeout-minutes` before it: a key a reviewer reads as a control that
// controls nothing. This is the rule that makes it one, and the case it must
// never get wrong is a fork.

import { describe, expect, test } from 'bun:test'
import { grantsFor, JOB_TOKEN_MINUTES } from '../../app/Actions/Workflow/jobToken'

describe('what a job\'s token may do', () => {
  test('a workflow that says nothing gets read access and nothing else', () => {
    /*
     * Actions' own default depends on an organization setting, which is a
     * footgun this instance declines to reproduce: silence means the same
     * thing on every instance, forever.
     */
    const grants = grantsFor({ workflowPermissions: null, jobPermissions: null, trusted: true })

    expect(grants.granted).toEqual({ contents: 'read' })
  })

  test('a job\'s permissions replace the workflow\'s rather than adding to them', () => {
    const grants = grantsFor({
      workflowPermissions: { contents: 'write', issues: 'write' },
      jobPermissions: { contents: 'read' },
      trusted: true,
    })

    expect(grants.granted).toEqual({ contents: 'read' })
  })

  test('and a key this instance has no scope for is reported rather than ignored', () => {
    // `packages: write` is a real permission for a feature that does not exist
    // here, and the author deserves to be told rather than left wondering why
    // the far end refuses.
    const grants = grantsFor({
      workflowPermissions: { 'contents': 'read', 'packages': 'write' },
      jobPermissions: null,
      trusted: true,
    })

    expect(grants.unsupported).toContain('packages')
  })
})

describe('a fork\'s pull request', () => {
  test('gets read access whatever its own workflow file declares', () => {
    /*
     * The rule most likely to be lost in a refactor, which is why it lives in
     * one function with a test on it: the workflow in a fork's branch is the
     * fork's code, and it does not get to decide what it may do to this
     * repository.
     */
    const grants = grantsFor({
      workflowPermissions: { contents: 'write', 'pull-requests': 'write' },
      jobPermissions: null,
      trusted: false,
    })

    expect(grants.granted).toEqual({ contents: 'read' })
  })

  test('and the reduction is reported, so a screen can say why', () => {
    const grants = grantsFor({
      workflowPermissions: { contents: 'write' },
      jobPermissions: null,
      trusted: false,
    })

    expect(grants.reduced).toBe(true)
  })

  test('while a fork asking for nothing is not "reduced" - it wanted read access', () => {
    // The distinction matters for what a screen says: nothing was taken away
    // from a workflow that asked for the default.
    expect(grantsFor({ workflowPermissions: null, jobPermissions: null, trusted: false }).reduced).toBe(false)
  })
})

describe('its life', () => {
  test('is an hour at most, so a runner that dies leaves nothing usable for long', () => {
    // The ordinary path revokes it when the job reports; this is the backstop
    // for the machine that never reports at all.
    expect(JOB_TOKEN_MINUTES).toBeLessThanOrEqual(60)
    expect(JOB_TOKEN_MINUTES).toBeGreaterThan(0)
  })
})
