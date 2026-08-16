// Concurrency groups: which runs may exist at once.
//
// This is the key the roadmap names Gitea for accepting and ignoring, which is
// how a workflow that depends on it looks like it works. The group is a
// template, so everything here is about resolving one against the event that
// started the run - and about what to do when it cannot be resolved, which is
// the case where being wrong cancels somebody's build.

import { describe, expect, test } from 'bun:test'
import { fillGroup, resolveGroup } from '../../app/Actions/Workflow/concurrency'

const push = {
  workflow: 'CI',
  eventName: 'push',
  ref: 'refs/heads/main',
  sha: 'abc123',
}

const pullRequest = {
  workflow: 'CI',
  eventName: 'pull_request',
  ref: 'refs/pull/12/head',
  sha: 'def456',
  headRef: 'feature/thing',
  baseRef: 'main',
  number: 12,
}

describe('resolving a group', () => {
  test('a literal group is itself', () => {
    expect(resolveGroup('deploy-production', push)).toBe('deploy-production')
  })

  test('the common template resolves against the event', () => {
    // `${{ github.workflow }}-${{ github.ref }}` is the group in most
    // repositories that use one at all.
    expect(resolveGroup('${{ github.workflow }}-${{ github.ref }}', push)).toBe('CI-refs/heads/main')
  })

  test('and ref_name is the branch without its refs/heads prefix', () => {
    expect(resolveGroup('${{ github.ref_name }}', push)).toBe('main')
    expect(resolveGroup('${{ github.ref_name }}', { ...push, ref: 'refs/tags/v1.0.0' })).toBe('v1.0.0')
  })

  test('a pull request can group on its head branch or its number', () => {
    expect(resolveGroup('pr-${{ github.head_ref }}', pullRequest)).toBe('pr-feature/thing')
    expect(resolveGroup('pr-${{ github.event.pull_request.number }}', pullRequest)).toBe('pr-12')
  })

  test('no concurrency means no group', () => {
    expect(resolveGroup(null, push)).toBeNull()
    expect(resolveGroup('', push)).toBeNull()
    expect(resolveGroup('   ', push)).toBeNull()
  })

  /*
   * The case that decides whether this feature is safe to ship.
   *
   * An expression this cannot resolve - a function call, a fallback, a secret -
   * would otherwise leave the same literal text for every run of the workflow,
   * grouping runs that should be independent. Under `cancel-in-progress` that
   * cancels somebody's build. Grouping too little only wastes runners, so no
   * group is the answer.
   */
  test('an expression that cannot be resolved is no group at all', () => {
    expect(resolveGroup('${{ github.head_ref || github.ref }}', push)).toBeNull()
    expect(resolveGroup('${{ inputs.environment }}', push)).toBeNull()
    expect(resolveGroup('deploy-${{ secrets.SOMETHING }}', push)).toBeNull()
  })

  test('and a partly resolvable one is too, rather than half a group', () => {
    expect(resolveGroup('${{ github.workflow }}-${{ hashFiles("**/lock") }}', push)).toBeNull()
  })

  /*
   * Actions does not namespace a group by event, and people rely on that:
   * `group: ${{ github.ref }}` is written to stop a branch's push run and its
   * pull request run from both running. Adding the event name would be a
   * reasonable-looking change that quietly breaks the most common group there
   * is.
   */
  test('the same group string from two events is the same group', () => {
    const fromPush = resolveGroup('${{ github.workflow }}', push)
    const fromPull = resolveGroup('${{ github.workflow }}', pullRequest)

    expect(fromPush).toBe(fromPull)
  })

  test('a very long group is truncated rather than refused', () => {
    expect(resolveGroup('x'.repeat(900), push)).toHaveLength(500)
  })
})

describe('filling a template', () => {
  test('leaves unknown references exactly as written', () => {
    expect(fillGroup('${{ github.workflow }}/${{ github.actor }}', push)).toBe('CI/${{ github.actor }}')
  })

  test('and tolerates the spacing people actually write', () => {
    expect(fillGroup('${{github.ref}}', push)).toBe('refs/heads/main')
    expect(fillGroup('${{   github.ref   }}', push)).toBe('refs/heads/main')
  })

  test('an empty context value fills as empty rather than as the expression', () => {
    // A push has no head_ref. `pr-` is a worse group than `pr-feature`, but it
    // is an honest one, and `resolveGroup` only rejects what it could not
    // resolve at all.
    expect(fillGroup('pr-${{ github.head_ref }}', push)).toBe('pr-')
  })
})
