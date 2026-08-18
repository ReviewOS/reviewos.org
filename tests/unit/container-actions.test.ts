// `uses: docker://image`, and the command line it becomes.
//
// The argv is where a container run goes wrong silently. A missing `--rm`
// leaks containers until a build machine has no disk; a mount at the wrong
// path makes an action see an empty workspace and do nothing; an environment
// variable still carrying a host path sends a tool at a directory that does not
// exist inside, so an action writes its outputs to nowhere and the job goes
// green with empty results. None of those fail loudly, and all of them are
// testable without a container runtime.

import { describe, expect, test } from 'bun:test'
import { parseActionFile } from '../../app/Actions/Runner/actionFile'
import { parseActionRef } from '../../app/Actions/Runner/actionRef'
import { containerCommand, CONTAINER_WORKSPACE, containerRuntime, splitArguments, translate } from '../../app/Actions/Runner/container'

const base = {
  image: 'ghcr.io/acme/publish:1.4.0',
  workspace: '/var/run/reviewos/workspace',
  environment: { GITHUB_WORKSPACE: '/var/run/reviewos/workspace', INPUT_TAG: 'v2' },
}

describe('the command line', () => {
  test('mounts the workspace where every action written for Actions looks', () => {
    const argv = containerCommand('docker', base)

    expect(argv.slice(0, 3)).toEqual(['docker', 'run', '--rm'])
    expect(argv).toContain('--volume')
    expect(argv).toContain(`${base.workspace}:${CONTAINER_WORKSPACE}`)
    expect(argv[argv.indexOf('--workdir') + 1]).toBe(CONTAINER_WORKSPACE)
    // The image is last of the flags and first of the command, which is what
    // makes the arguments after it the container's rather than the runtime's.
    expect(argv).toContain(base.image)
  })

  test('drops nothing into a shell, so a workflow cannot inject one', () => {
    const argv = containerCommand('docker', {
      ...base,
      args: 'publish --message "a title; rm -rf /"',
    })

    // An argv, executed directly. The semicolon is an argument rather than a
    // separator, and no quoting rule has to be got right for that to hold.
    expect(argv).toContain('a title; rm -rf /')
    expect(argv.join(' ')).not.toContain('sh -c')
  })

  test('passes every variable with its value, never by name', () => {
    const argv = containerCommand('docker', base)
    const flags = argv.filter((one, index) => argv[index - 1] === '--env')

    // `--env KEY` would read the value out of the *runner's* environment, which
    // is a way for a workflow to ask for a variable this process holds and the
    // job was never given.
    expect(flags.every(one => one.includes('='))).toBe(true)
    expect(flags).toContain('INPUT_TAG=v2')
  })

  test('and refuses the container extra privileges', () => {
    const argv = containerCommand('podman', base)

    // An action asking for them is asking for the machine rather than for a
    // container, and a runner that grants it has no isolation left to offer.
    expect(argv[argv.indexOf('--security-opt') + 1]).toBe('no-new-privileges')
    expect(argv[0]).toBe('podman')
  })

  test('honours an entrypoint the step named', () => {
    const argv = containerCommand('docker', { ...base, entrypoint: '/bin/sh', args: '-c "echo hi"' })

    expect(argv[argv.indexOf('--entrypoint') + 1]).toBe('/bin/sh')
    expect(argv.slice(argv.indexOf(base.image) + 1)).toEqual(['-c', 'echo hi'])
  })
})

describe('paths inside', () => {
  test('are translated, so an action writes its outputs somewhere real', () => {
    const inside = translate({
      GITHUB_OUTPUT: '/var/run/reviewos/workspace/.reviewos-runner/output-3',
      GITHUB_WORKSPACE: '/var/run/reviewos/workspace',
      MESSAGE: 'built in /var/run/reviewos/workspace, apparently',
      HOME: '/root',
    }, '/var/run/reviewos/workspace')

    expect(inside.GITHUB_OUTPUT).toBe(`${CONTAINER_WORKSPACE}/.reviewos-runner/output-3`)
    expect(inside.GITHUB_WORKSPACE).toBe(CONTAINER_WORKSPACE)
    // A value that merely contains the path is not a path: rewriting it would
    // edit somebody's message.
    expect(inside.MESSAGE).toBe('built in /var/run/reviewos/workspace, apparently')
    expect(inside.HOME).toBe('/root')
  })
})

describe('arguments', () => {
  test('split the way a shell would, without one', () => {
    expect(splitArguments('publish --tag v2')).toEqual(['publish', '--tag', 'v2'])
    expect(splitArguments('--message "two words"')).toEqual(['--message', 'two words'])
    expect(splitArguments("--message 'two words'")).toEqual(['--message', 'two words'])
    // An empty argument is a thing somebody means: `--message ""` says the
    // message is empty, which is not the same as not passing it.
    expect(splitArguments('--message ""')).toEqual(['--message', ''])
    expect(splitArguments('   ')).toEqual([])
  })
})

describe('the reference and the action file', () => {
  test('read a `docker://` step as an image', () => {
    const reference = parseActionRef('docker://ghcr.io/acme/publish:1.4.0')

    expect(reference.kind).toBe('container')
    expect(reference.image).toBe('ghcr.io/acme/publish:1.4.0')
  })

  test('and an action.yml that names a published image', () => {
    const definition = parseActionFile([
      'name: Publish',
      'runs:',
      '  using: docker',
      '  image: docker://ghcr.io/acme/publish:1.4.0',
      '  entrypoint: /entry.sh',
      '  args:',
      '    - publish',
      '    - "a title with spaces"',
    ].join('\n'))

    expect(definition.kind).toBe('docker')
    expect(definition.image).toBe('docker://ghcr.io/acme/publish:1.4.0')
    expect(definition.entrypoint).toBe('/entry.sh')
    // Joined here and split by the runner: one set of quoting rules rather than
    // two, because `with.args` from a `docker://` step arrives as one string.
    expect(splitArguments(String(definition.args))).toEqual(['publish', 'a title with spaces'])
  })

  test('and a Dockerfile action is read, so the runner can refuse it by name', () => {
    const definition = parseActionFile('name: Build\nruns:\n  using: docker\n  image: Dockerfile\n')

    // Building an image would make this runner a build host for arbitrary
    // images from the repository whose workflow it is running - a bigger
    // decision than "may containers run here", with its own cache and its own
    // supply chain.
    expect(definition.kind).toBe('docker')
    expect(definition.image).toBe('Dockerfile')
  })
})

describe('the runtime', () => {
  test('is whichever is on PATH, docker first', async () => {
    expect(await containerRuntime(async binary => binary === 'podman')).toBe('podman')
    expect(await containerRuntime(async () => true)).toBe('docker')
  })

  test('and null is a first-class answer', async () => {
    // A runner with no container runtime is the ordinary case. The step that
    // needs one is told so by name rather than failing on a command not found.
    expect(await containerRuntime(async () => false)).toBeNull()
  })
})
