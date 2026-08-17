// The step kinds: what a job *is*, beyond "a list of commands".
//
// Actions has one kind and expresses the rest through job structure. This
// engine has four, and the extra three are the ones a real pipeline needs and
// cannot say: a barrier, a gate a person opens, and a job that starts another
// run. All three are decided by the control plane rather than by a machine,
// which is the property every test here is really about.
//
// Everything lives under one `reviewos:` key. That is the portability
// statement: one key to delete, one word to grep for, and a workflow that uses
// none of it is a workflow GitHub runs unchanged.

import { describe, expect, test } from 'bun:test'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

function jobs(source: string): any[] {
  const result = parseWorkflow(`name: X\non: push\n${source}`, '.github/workflows/x.yml')

  if (result.errors.length > 0)
    throw new Error(result.errors.map(error => error.message).join('; '))

  return result.workflow!.jobs
}

/*
 * Message and fix together, because a refusal here is only useful if it says
 * what to do: "`integer` is not a field type" is half an answer, and the other
 * half - which types there are - lives in `fix`.
 */
function errorsIn(source: string): string[] {
  return parseWorkflow(`name: X\non: push\n${source}`, '.github/workflows/x.yml')
    .errors
    .map(error => `${error.message} ${error.fix ?? ''}`)
}

describe('a job with no reviewos: key', () => {
  test('is a command job, which is every job Actions can write', () => {
    const [job] = jobs(`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`)

    expect(job.kind).toBe('command')
    expect(job.settings).toEqual({})
    expect(job.group).toBeNull()
  })
})

describe('a wait step', () => {
  /*
   * Buildkite's wait is positional: everything before it finishes before
   * anything after it starts. Turning that into `needs:` edges at parse time is
   * what keeps the graph a reader sees and the graph that runs the same one.
   */
  test('is normalized into needs, in both directions', () => {
    const [build, lint, barrier, deploy] = jobs(`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: lint
  everything-built:
    reviewos:
      wait: true
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
`)

    expect(build!.needs).toEqual([])
    expect(lint!.needs).toEqual([])

    // The barrier waits for everything declared before it...
    expect(barrier!.kind).toBe('wait')
    expect(barrier!.needs.sort()).toEqual(['build', 'lint'])

    // ...and everything after it waits for the barrier.
    expect(deploy!.needs).toEqual(['everything-built'])
  })

  test('and a job that named its own dependencies keeps them', () => {
    const [, , after] = jobs(`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  barrier:
    reviewos:
      wait: true
  publish:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - run: ./publish
`)

    // An explicit `needs:` is a statement about the graph, and a barrier must
    // not quietly widen it.
    expect(after!.needs).toEqual(['build'])
  })

  test('continue-on-failure is the variant that lets a failed run past', () => {
    const [, barrier] = jobs(`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  anyway:
    reviewos:
      wait:
        continue-on-failure: true
`)

    expect(barrier!.settings).toEqual({ continueOnFailure: true })
  })

  test('a wait job needs no runs-on, because it reaches no machine', () => {
    expect(errorsIn(`jobs:
  barrier:
    reviewos:
      wait: true
`)).toEqual([])
  })
})

describe('a block step', () => {
  test('the short form is a prompt', () => {
    const [gate] = jobs(`jobs:
  approve:
    reviewos:
      block: Deploy to production?
`)

    expect(gate!.kind).toBe('block')
    expect(gate!.settings).toEqual({ prompt: 'Deploy to production?', fields: [] })
  })

  test('and fields make it an input step, which is the same row', () => {
    const [gate] = jobs(`jobs:
  approve:
    reviewos:
      block:
        prompt: Ship it?
        fields:
          - key: version
            type: string
            required: true
          - key: where
            type: select
            options: [staging, production]
            default: staging
`)

    const fields = (gate!.settings as any).fields

    expect(fields).toHaveLength(2)
    expect(fields[0]).toMatchObject({ key: 'version', type: 'string', required: true })
    expect(fields[1]).toMatchObject({ key: 'where', type: 'select', options: ['staging', 'production'], default: 'staging' })
  })

  test('a select with no options is refused, because nobody could answer it', () => {
    expect(errorsIn(`jobs:
  approve:
    reviewos:
      block:
        fields:
          - key: where
            type: select
`).join(' ')).toContain('no options')
  })

  test('a field with no key is refused, because later jobs read it by name', () => {
    expect(errorsIn(`jobs:
  approve:
    reviewos:
      block:
        fields:
          - type: string
`).join(' ')).toContain('no `key`')
  })

  test('and an unknown type names the ones there are', () => {
    expect(errorsIn(`jobs:
  approve:
    reviewos:
      block:
        fields:
          - key: n
            type: integer
`).join(' ')).toContain('`string`, `boolean` and `select`')
  })
})

describe('a trigger step', () => {
  test('the short form names a workflow', () => {
    const [job] = jobs(`jobs:
  announce:
    reviewos:
      trigger: release.yml
`)

    expect(job!.kind).toBe('trigger')
    expect(job!.settings).toEqual({ workflow: 'release.yml', inputs: {}, await: false })
  })

  test('the long form carries inputs, and waits only when asked', () => {
    const [job] = jobs(`jobs:
  announce:
    reviewos:
      trigger:
        workflow: release.yml
        inputs:
          version: 1.2.3
        await: true
`)

    expect(job!.settings).toMatchObject({ workflow: 'release.yml', inputs: { version: '1.2.3' }, await: true })
  })

  test('a trigger that names nothing is refused rather than doing nothing', () => {
    // A pipeline whose deploy stage silently did nothing is the failure this
    // whole phase exists to avoid.
    expect(errorsIn(`jobs:
  announce:
    reviewos:
      trigger:
        inputs:
          version: 1
`).join(' ')).toContain('triggers nothing')
  })
})

describe('the rules that keep the kinds apart', () => {
  test('a job is one kind', () => {
    expect(errorsIn(`jobs:
  confused:
    reviewos:
      wait: true
      block: Really?
`).join(' ')).toContain('at once')
  })

  test('and a kind that is not a command runs no commands', () => {
    expect(errorsIn(`jobs:
  gate:
    runs-on: ubuntu-latest
    reviewos:
      block: Ship?
    steps:
      - run: ./deploy
`).join(' ')).toContain('also has steps')
  })

  test('an unknown reviewos: key names the ones there are', () => {
    expect(errorsIn(`jobs:
  odd:
    reviewos:
      pause: true
`).join(' ')).toContain('`wait`, `block`, `trigger` and `group`')
  })
})

describe('groups', () => {
  test('are a label, not a container', () => {
    // A label keeps the jobs in the order the file declared them, which is what
    // a reader is checking the screen against. Nesting them inside a container
    // would change every query that reads a run.
    const [one, two] = jobs(`jobs:
  compile:
    runs-on: ubuntu-latest
    reviewos:
      group: Build
    steps:
      - run: make
  package:
    runs-on: ubuntu-latest
    reviewos:
      group: Build
    steps:
      - run: make dist
`)

    expect(one!.group).toBe('Build')
    expect(two!.group).toBe('Build')
    expect(one!.kind).toBe('command')
  })
})

describe('if-changed, the monorepository primitive', () => {
  test('is a list of globs on the job', () => {
    const [api, web] = jobs(`jobs:
  api:
    runs-on: ubuntu-latest
    reviewos:
      if-changed:
        - packages/api/**
        - package.json
    steps:
      - run: make api
  web:
    runs-on: ubuntu-latest
    reviewos:
      if-changed: packages/web/**
    steps:
      - run: make web
`)

    expect(api!.ifChanged).toEqual(['packages/api/**', 'package.json'])
    // The single-glob form, because most jobs have one.
    expect(web!.ifChanged).toEqual(['packages/web/**'])
  })

  test('a job that says nothing always runs', () => {
    const [job] = jobs(`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`)

    expect(job!.ifChanged).toEqual([])
  })

  test('and a barrier or a gate cannot be skipped by it', () => {
    /*
     * A barrier that only sometimes exists changes the shape of the graph -
     * the jobs after it would have nothing to wait for - and a deployment gate
     * that vanishes because no file matched is a gate that approves itself.
     */
    expect(errorsIn(`jobs:
  gate:
    reviewos:
      block: Ship?
      if-changed: packages/api/**
`).join(' ')).toContain('cannot be skipped by')
  })
})
