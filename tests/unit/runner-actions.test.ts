// `uses:` - what a step is asking to run, whether it may, and what running it
// means.
//
// The reference forms are not variations on one idea: a local path is a
// directory in the tree that was just checked out, a remote reference is
// somebody else's repository over the network, an image is pulled from a
// registry. Every decision after this - what to fetch, what to trust, what to
// refuse - turns on telling them apart correctly.

import { describe, expect, test } from 'bun:test'
import { checkPolicy, defaultPolicy, parseActionRef } from '../../app/Actions/Runner/actionRef'
import { inputEnvironment, inputName, missingInputs, parseActionFile } from '../../app/Actions/Runner/actionFile'

describe('reading a reference', () => {
  test('a local path', () => {
    expect(parseActionRef('./.reviewos/actions/build')).toMatchObject({
      kind: 'local',
      path: '.reviewos/actions/build',
    })
  })

  /*
   * A step reaching out of the checkout is asking for a directory the runner
   * put there, which on a host runner is the rest of the machine.
   */
  test('and one that climbs out of the workspace is not a reference at all', () => {
    expect(parseActionRef('./../../etc').kind).toBe('unknown')
    expect(parseActionRef('./a/../../b').kind).toBe('unknown')
  })

  test('owner and name, with a version', () => {
    expect(parseActionRef('actions/checkout@v4')).toMatchObject({
      kind: 'remote',
      repository: 'actions/checkout',
      ref: 'v4',
      pinned: false,
      subdirectory: null,
    })
  })

  test('a subdirectory inside a repository', () => {
    expect(parseActionRef('owner/name/tools/lint@v1')).toMatchObject({
      repository: 'owner/name',
      subdirectory: 'tools/lint',
    })
  })

  test('a commit sha is the only pinned form', () => {
    const sha = 'a'.repeat(40)

    expect(parseActionRef(`owner/name@${sha}`).pinned).toBe(true)
    expect(parseActionRef('owner/name@v4.1.0').pinned).toBe(false)
    // Short shas are not pinning: they are ambiguous by construction, and a
    // seven-character prefix can be brute-forced onto a different object.
    expect(parseActionRef('owner/name@a1b2c3d').pinned).toBe(false)
  })

  test('a fully qualified URL names its own host', () => {
    expect(parseActionRef('https://code.example.com/owner/name@v1')).toMatchObject({
      kind: 'remote',
      host: 'code.example.com',
      repository: 'owner/name',
      ref: 'v1',
    })
  })

  test('a container image', () => {
    expect(parseActionRef('docker://alpine:3.20')).toMatchObject({ kind: 'container', image: 'alpine:3.20' })
  })

  test('and anything else is unknown rather than guessed at', () => {
    // Guessing would mean running something other than what was asked for, and
    // the failure mode of that is not a broken build but the wrong code.
    for (const value of ['', 'justaname', '@v4', 'https://example.com/onlyone'])
      expect(parseActionRef(value).kind).toBe('unknown')
  })
})

describe('the policy', () => {
  test('a local action is always allowed', () => {
    // It is code from the repository whose workflow is running, which is the
    // same code the steps themselves are.
    expect(checkPolicy(parseActionRef('./actions/x'), defaultPolicy()).allowed).toBe(true)
  })

  test('and by default nothing else is', () => {
    const policy = defaultPolicy()

    expect(checkPolicy(parseActionRef('actions/checkout@v4'), policy).allowed).toBe(false)
    expect(checkPolicy(parseActionRef('docker://alpine'), policy).allowed).toBe(false)
  })

  test('an allowed host lets its actions through', () => {
    const policy = { ...defaultPolicy(), allowedHosts: ['github.com'], defaultHost: 'github.com' }

    expect(checkPolicy(parseActionRef('actions/checkout@v4'), policy).allowed).toBe(true)
    expect(checkPolicy(parseActionRef('https://elsewhere.example/owner/name@v1'), policy).allowed).toBe(false)
  })

  test('an unqualified reference needs a default host to mean anything', () => {
    const policy = { ...defaultPolicy(), allowedHosts: ['*'] }
    const decision = checkPolicy(parseActionRef('actions/checkout@v4'), policy)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('no default action host')
  })

  test('a version is required, because a moving default is not a version', () => {
    const policy = { ...defaultPolicy(), allowedHosts: ['*'], defaultHost: 'github.com' }

    expect(checkPolicy(parseActionRef('actions/checkout'), policy).allowed).toBe(false)
  })

  /*
   * The supply-chain option. A tag is a moving target the publisher can
   * repoint after a review has read it; a sha cannot be repointed.
   */
  test('pinning can be required, and then a tag is refused', () => {
    const policy = { ...defaultPolicy(), allowedHosts: ['*'], defaultHost: 'github.com', requirePinnedSha: true }

    expect(checkPolicy(parseActionRef('actions/checkout@v4'), policy).allowed).toBe(false)
    expect(checkPolicy(parseActionRef(`actions/checkout@${'b'.repeat(40)}`), policy).allowed).toBe(true)
  })
})

describe('reading an action file', () => {
  const composite = `name: Greet
description: Says hello
inputs:
  who:
    description: Who to greet
    default: world
  loudly:
    description: Shout it
    required: true
runs:
  using: composite
  steps:
    - name: Say it
      shell: bash
      run: echo "hello \${{ inputs.who }}"
`

  test('a composite action and its steps', () => {
    const definition = parseActionFile(composite)

    expect(definition.kind).toBe('composite')
    expect(definition.steps).toHaveLength(1)
    expect(definition.steps[0]).toMatchObject({ name: 'Say it', shell: 'bash' })
    expect(definition.inputs.map(input => input.name)).toEqual(['who', 'loudly'])
  })

  test('a JavaScript action, by runtime prefix rather than by a list', () => {
    // The list of node versions changes every year, and a runner refusing
    // `node24` for not being in an array it was compiled with ages badly.
    const definition = parseActionFile('runs:\n  using: node24\n  main: dist/index.js\n')

    expect(definition).toMatchObject({ kind: 'javascript', runtime: 'node24', main: 'dist/index.js' })
  })

  test('a JavaScript action with no main is an error, not a mystery', () => {
    expect(parseActionFile('runs:\n  using: node20\n').error).toContain('main')
  })

  test('a Docker action keeps its image', () => {
    expect(parseActionFile('runs:\n  using: docker\n  image: docker://alpine\n')).toMatchObject({
      kind: 'docker',
      image: 'docker://alpine',
    })
  })

  test('a file that cannot be read is an error rather than a throw', () => {
    // The job should fail, not the runner.
    expect(parseActionFile('runs: [this is not a mapping]').error).toBeTruthy()
    expect(parseActionFile('').error).toBeTruthy()
    expect(parseActionFile('name: x\n').error).toContain('runs')
  })
})

describe('inputs an action sees', () => {
  const definition = parseActionFile(`inputs:
  who:
    default: world
  my name:
    default: nobody
runs:
  using: composite
  steps: []
`)

  test('become INPUT_ variables, upper-cased with spaces underscored', () => {
    // An action reading `INPUT_MY_NAME` relies on exactly this transformation,
    // and getting it wrong means the input silently arrives empty.
    expect(inputName('my name')).toBe('INPUT_MY_NAME')

    const environment = inputEnvironment(definition, { who: 'everyone' })

    expect(environment.INPUT_WHO).toBe('everyone')
    expect(environment.INPUT_MY_NAME).toBe('nobody')
  })

  test('a supplied value beats a default', () => {
    expect(inputEnvironment(definition, { who: 'you' }).INPUT_WHO).toBe('you')
  })

  test('a missing required input is reported rather than refused', () => {
    // Actions itself only warns, and an action that copes without one would
    // otherwise stop working here for no reason a person could see.
    const required = parseActionFile('inputs:\n  token:\n    required: true\nruns:\n  using: composite\n  steps: []\n')

    expect(missingInputs(required, {})).toEqual(['token'])
    expect(missingInputs(required, { token: 'x' })).toEqual([])
  })
})
