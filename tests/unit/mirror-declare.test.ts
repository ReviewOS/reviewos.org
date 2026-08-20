// The mirrors, read from a file rather than from whoever ran the command.
//
// Written for a failure that left no trace anywhere: `stacksjs/.github` was
// never mirrored, so `/stacks` looked for a profile in four repositories,
// found none, and rendered exactly what an organization that never wrote one
// renders. Nothing was logged, nothing was red, and the record of which
// mirrors the instance was supposed to have lived in whoever had typed
// `mirror:add` that month.
//
// What is pinned here is the reading and the planning, which is where the
// answers that matter are decided: an additive plan, a file that says nothing
// twice, and a declaration naming an owner this instance does not have being
// early rather than fatal - because this runs in a deploy's pre-start, and a
// fatal there is a release that will not start.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { localNameOf, readDeclaration } from '../../app/Actions/Mirror/declare'
import { tsCloud } from '../../config/cloud'

const ROOT = join(import.meta.dir, '../..')

describe('reading a declaration', () => {
  test('takes the lines that name both halves', () => {
    const { mirrors, error } = readDeclaration(`
mirrors:
  - remote: stacksjs/.github
    owner: stacks
  - remote: stacksjs/stacks
    owner: stacks
    name: framework
    metadata: true
    interval: 300
`)

    expect(error).toBeNull()
    expect(mirrors.mirrors).toHaveLength(2)
    expect(mirrors.mirrors[1]).toMatchObject({ remote: 'stacksjs/stacks', owner: 'stacks', name: 'framework', metadata: true, interval: 300 })
  })

  test('drops a line missing the half that cannot be guessed', () => {
    // An upstream with no local owner is not a mirror anybody can create, and
    // guessing the owner from the remote is how `stacksjs/stacks` lands under
    // an organization called `stacksjs` that nobody made.
    const { mirrors } = readDeclaration(`
mirrors:
  - remote: stacksjs/.github
  - owner: stacks
  - remote: stacksjs/.github
    owner: stacks
`)

    expect(mirrors.mirrors).toHaveLength(1)
  })

  test('a file that is not a declaration is an error rather than an exception', () => {
    expect(readDeclaration('just a sentence').error).not.toBeNull()
    expect(readDeclaration('').error).not.toBeNull()
  })

  test('a file with no mirrors is a valid file with nothing to do', () => {
    const { mirrors, error } = readDeclaration('mirrors: []')

    expect(error).toBeNull()
    expect(mirrors.mirrors).toEqual([])
  })
})

describe('what a declared mirror is called here', () => {
  test('the upstream name, which is the case worth not writing down', () => {
    expect(localNameOf({ remote: 'stacksjs/.github', owner: 'stacks' })).toBe('.github')
  })

  test('or the name the file gives it, because the two are different facts', () => {
    // `stacksjs/stacks` upstream is `stacks/stacks` here. Deriving the local
    // name would make a rename impossible and collide the moment two hosts use
    // the same owner name.
    expect(localNameOf({ remote: 'stacksjs/stacks', owner: 'stacks', name: 'framework' })).toBe('framework')
  })

  test('and a remote written as a URL is still an owner and a name', () => {
    expect(localNameOf({ remote: 'https://github.com/stacksjs/.github.git', owner: 'stacks' })).toBe('.github')
  })
})

describe('the file this repository ships', () => {
  test('exists, and parses', () => {
    expect(existsSync(join(ROOT, 'mirrors.yml'))).toBe(true)

    const { mirrors, error } = readDeclaration(readFileSync(join(ROOT, 'mirrors.yml'), 'utf8'))

    expect(error).toBeNull()
    expect(mirrors.mirrors.length).toBeGreaterThan(0)
  })

  test('declares the profile repository whose absence started this', () => {
    const { mirrors } = readDeclaration(readFileSync(join(ROOT, 'mirrors.yml'), 'utf8'))

    expect(mirrors.mirrors.some(row => row.remote === 'stacksjs/.github' && row.owner === 'stacks')).toBe(true)
  })

  test('names an owner shaped like one, and an upstream shaped like one', () => {
    const { mirrors } = readDeclaration(readFileSync(join(ROOT, 'mirrors.yml'), 'utf8'))

    for (const row of mirrors.mirrors) {
      expect(row.remote).toMatch(/^[\w.-]+\/[\w.-]+$/)
      expect(row.owner).toMatch(/^[\w-]+$/)
    }
  })
})

describe('the deploy applies it', () => {
  test('after migrate, because it writes rows', () => {
    // The ordering is the whole point of asserting this: `mirror:apply` writes
    // to tables `migrate` creates, and a fresh box runs both on its first
    // deploy.
    const steps: string[] = (tsCloud as any)?.sites?.reviewos?.preStart ?? []
    const migrate = steps.findIndex(step => step.includes('cli.js migrate'))
    const apply = steps.findIndex(step => step.includes('mirror:apply'))

    expect(migrate).toBeGreaterThanOrEqual(0)
    expect(apply).toBeGreaterThan(migrate)
  })

  test('and writes this instance\'s own profile page from a file that exists', () => {
    // `/reviewos` was blank because nobody had created the repository behind
    // it. The content is a file here now; the step that writes it names both,
    // and both have to be real or the page stays blank with nothing saying so.
    const steps: string[] = (tsCloud as any)?.sites?.reviewos?.preStart ?? []
    const step = steps.find(row => row.includes('profile:seed')) ?? ''

    expect(step).toContain('--owner reviewos')

    const file = /--file\s+(\S+)/.exec(step)?.[1]

    expect(file).toBeTruthy()
    expect(existsSync(join(ROOT, file!))).toBe(true)
  })

  test('naming a CLI and a file this repository actually ships', () => {
    // The failure this mirrors is in `cloud-queues.test.ts`: seven workers
    // whose ExecStart named a vendored core this layout does not have, crash
    // looping for a week while systemd reported them starting.
    const steps: string[] = (tsCloud as any)?.sites?.reviewos?.preStart ?? []
    const step = steps.find(row => row.includes('mirror:apply')) ?? ''

    const entry = /\bbun\s+(\S+\.(?:ts|js))\b/.exec(step)?.[1]
    const file = step.split(/\s+/).at(-1) ?? ''

    expect(entry).toBeTruthy()
    expect(existsSync(join(ROOT, entry!))).toBe(true)
    expect(existsSync(join(ROOT, file))).toBe(true)
  })
})
