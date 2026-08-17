// What a step can see: the default variable set, and the event payload.
//
// Both are compatibility surfaces rather than features - nothing here is
// interesting except that it is exactly what a workflow written for Actions
// expects to find. The failure mode is quiet in both directions: an action that
// reads an unset variable does the wrong thing without complaining, and one
// that reads an empty event payload does nothing at all.

import { describe, expect, test } from 'bun:test'
import { environmentFor } from '../../app/Actions/Runner/localExecutor'
import { eventPayload } from '../../app/Actions/Workflow/eventPayload'

const job = {
  key: 'build',
  repository_full_name: 'acme/widgets',
  event_path: '/w/.reviewos-runner/event.json',
  server_url: 'https://reviewos.example',
  api_url: 'https://reviewos.example/api',
  run: {
    id: 12,
    number: 34,
    event: 'pull_request',
    ref: 'refs/heads/feature',
    head_sha: 'c'.repeat(40),
    workflow: 'CI',
    actor: 'ada',
    head_ref: 'feature',
    base_ref: 'main',
  },
}

describe('the default environment', () => {
  test('carries the names an Actions workflow reads', () => {
    const environment = environmentFor(job, '/w')

    expect(environment.GITHUB_REPOSITORY).toBe('acme/widgets')
    expect(environment.GITHUB_REPOSITORY_OWNER).toBe('acme')
    expect(environment.GITHUB_WORKFLOW).toBe('CI')
    expect(environment.GITHUB_JOB).toBe('build')
    expect(environment.GITHUB_ACTOR).toBe('ada')
    expect(environment.GITHUB_RUN_ID).toBe('12')
    expect(environment.GITHUB_RUN_NUMBER).toBe('34')
    expect(environment.GITHUB_RUN_ATTEMPT).toBe('1')
    expect(environment.GITHUB_EVENT_NAME).toBe('pull_request')
    expect(environment.GITHUB_EVENT_PATH).toBe('/w/.reviewos-runner/event.json')
    expect(environment.GITHUB_WORKSPACE).toBe('/w')
    expect(environment.GITHUB_SERVER_URL).toBe('https://reviewos.example')
    expect(environment.GITHUB_API_URL).toBe('https://reviewos.example/api')
  })

  test('`refs/heads/feature` is also `feature`, which is what scripts want', () => {
    const environment = environmentFor(job, '/w')

    expect(environment.GITHUB_REF).toBe('refs/heads/feature')
    expect(environment.GITHUB_REF_NAME).toBe('feature')
    expect(environment.GITHUB_REF_TYPE).toBe('branch')
  })

  test('a tag says so', () => {
    const tagged = { ...job, run: { ...job.run, ref: 'refs/tags/v1.2.3' } }
    const environment = environmentFor(tagged, '/w')

    expect(environment.GITHUB_REF_NAME).toBe('v1.2.3')
    expect(environment.GITHUB_REF_TYPE).toBe('tag')
  })

  test('a pull request has both branches, and a push has neither', () => {
    expect(environmentFor(job, '/w').GITHUB_BASE_REF).toBe('main')
    expect(environmentFor(job, '/w').GITHUB_HEAD_REF).toBe('feature')

    /*
     * Empty rather than absent, on purpose: `if [ -n "$GITHUB_BASE_REF" ]` is
     * how a great deal of the ecosystem asks "am I on a pull request", and an
     * unset variable answers that the same way a wrong one does not.
     */
    const push = { ...job, run: { ...job.run, event: 'push', head_ref: '', base_ref: '' } }

    expect(environmentFor(push, '/w').GITHUB_BASE_REF).toBe('')
    expect('GITHUB_BASE_REF' in environmentFor(push, '/w')).toBe(true)
  })

  test('every GITHUB_ name is also a REVIEWOS_ name', () => {
    const environment = environmentFor(job, '/w')

    const github = Object.keys(environment).filter(name => name.startsWith('GITHUB_') && name !== 'GITHUB_ACTIONS')

    // Aliased rather than chosen: a script that reads one and a script that
    // reads the other are both right, and a forge that only answers to
    // somebody else's name is one that cannot be described in its own terms.
    for (const name of github)
      expect(environment[`REVIEWOS_${name.slice('GITHUB_'.length)}`]).toBe(environment[name]!)

    expect(github.length).toBeGreaterThan(15)
  })

  test('the runner describes the machine, and its temp is inside the workspace', () => {
    const environment = environmentFor(job, '/w')

    expect(['Linux', 'macOS', 'Windows']).toContain(environment.RUNNER_OS!)
    expect(['X86', 'X64', 'ARM', 'ARM64']).toContain(environment.RUNNER_ARCH!)

    // Not the host's `/tmp`: a step that writes there can read what the last
    // job left, and on a single-tenant box the last job may have been somebody
    // else's branch.
    expect(environment.RUNNER_TEMP).toContain('/w/')
    expect(environment.RUNNER_TOOL_CACHE).toContain('/w/')
  })

  test('and none of the control plane\'s own environment comes with it', () => {
    // The variables this process holds include the database credentials, and a
    // runner that passed its own environment through would be a way to read
    // every repository on the instance.
    const environment = environmentFor(job, '/w')

    for (const name of Object.keys(environment))
      expect(name.startsWith('DB_') || name.startsWith('APP_')).toBe(false)
  })
})

describe('the event payload', () => {
  const repository = {
    full_name: 'acme/widgets',
    name: 'widgets',
    owner: 'acme',
    visibility: 'public',
    default_branch: 'main',
  }

  test('a push carries the ref, the commit and who pushed', () => {
    const payload: any = eventPayload({
      event: 'push',
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
      runId: 5,
      runNumber: 9,
      repository,
      sender: { handle: 'ada', name: 'Ada' },
    })

    expect(payload.event).toBe('push')
    expect(payload.ref).toBe('refs/heads/main')
    expect(payload.after).toBe('a'.repeat(40))
    expect(payload.repository.full_name).toBe('acme/widgets')
    expect(payload.sender.handle).toBe('ada')
    expect(payload.workflow_run).toEqual({ id: 5, number: 9 })
  })

  test('a pull request nests its branches the way a script already reads them', () => {
    const payload: any = eventPayload({
      event: 'pull_request',
      ref: 'refs/heads/feature',
      sha: 'b'.repeat(40),
      runId: 6,
      runNumber: 10,
      repository,
      sender: null,
      pullRequest: {
        number: 42,
        title: 'Add the thing',
        state: 'open',
        draft: false,
        head_ref: 'feature',
        base_ref: 'main',
        head_sha: 'b'.repeat(40),
      },
    })

    // `event.pull_request.base.ref` is the path every changed-files action
    // writes, which is the entire reason to nest rather than flatten.
    expect(payload.pull_request.base.ref).toBe('main')
    expect(payload.pull_request.head.ref).toBe('feature')
    expect(payload.pull_request.number).toBe(42)
  })

  test('a subject run names what it was about, and its activity', () => {
    const payload: any = eventPayload({
      event: 'issues',
      ref: 'refs/heads/main',
      sha: 'c'.repeat(40),
      runId: 7,
      runNumber: 11,
      repository,
      sender: null,
      subject: { kind: 'issues', id: '7', action: 'opened' },
    })

    expect(payload.issue).toEqual({ id: '7', action: 'opened' })
    // Enough scripts branch on `event.action` that leaving it only inside the
    // subject would break them.
    expect(payload.action).toBe('opened')
  })

  test('dispatch inputs travel, and an empty set does not add a key', () => {
    const withInputs: any = eventPayload({
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      sha: 'd'.repeat(40),
      runId: 8,
      runNumber: 12,
      repository,
      sender: null,
      inputs: { environment: 'staging' },
    })

    expect(withInputs.inputs).toEqual({ environment: 'staging' })

    const without: any = eventPayload({
      event: 'push',
      ref: 'refs/heads/main',
      sha: 'd'.repeat(40),
      runId: 8,
      runNumber: 12,
      repository,
      sender: null,
      inputs: {},
    })

    expect('inputs' in without).toBe(false)
  })

  test('nothing carries a URL', () => {
    // This instance does not know its own address from inside a job - proxy,
    // tunnel, a different host name for the fleet - and a payload carrying one
    // that does not resolve is worse than one carrying none. The environment's
    // `GITHUB_SERVER_URL` is where a runner is told, by whoever configured it.
    const payload = eventPayload({
      event: 'push',
      ref: 'refs/heads/main',
      sha: 'e'.repeat(40),
      runId: 9,
      runNumber: 13,
      repository,
      sender: { handle: 'ada', name: null },
    })

    expect(JSON.stringify(payload)).not.toContain('http')
  })
})
