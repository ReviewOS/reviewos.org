// How the code gets into the workspace.
//
// The checkout is the step every job has and nobody writes, and the one that
// decides how long half of them take. The commands are built as data so the
// quoting and the option handling can be tested here rather than by running
// builds and reading logs.

import { describe, expect, test } from 'bun:test'
import { checkoutPlan, shellQuote } from '../../app/Actions/Runner/checkout'

const BARE = '/srv/reviewos/repos/acme/api.git'
const SHA = 'a'.repeat(40)

describe('quoting', () => {
  test('a value with a quote in it cannot end the argument', () => {
    /*
     * A repository, branch or path with a quote in its name is something
     * somebody is allowed to create, and every one of them ends up inside a
     * shell command here.
     */
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`)
    expect(shellQuote("foo'; rm -rf /")).toBe(`'foo'\\''; rm -rf /'`)
  })

  test('and an empty or missing value is still a quoted empty argument', () => {
    // Not nothing: an unquoted empty argument disappears, and the command that
    // follows silently reads its next argument as this one.
    expect(shellQuote('')).toBe(`''`)
    expect(shellQuote(undefined as any)).toBe(`''`)
  })
})

describe('the default', () => {
  test('on the instance\'s own machine, clones the bare repository without hardlinks', () => {
    const plan = checkoutPlan({ source: BARE, sha: SHA, onHost: true })

    // `--no-hardlinks` so a step running `git gc` cannot write into the object
    // store everybody pushes to.
    expect(plan.commands[0]).toContain('--no-hardlinks')
    expect(plan.commands[0]).toContain(`'${BARE}'`)
    expect(plan.commands.at(-1)).toBe(`git checkout --quiet '${SHA}'`)
    expect(plan.summary).toBe('full history')
  })

  test('and anywhere else, fetches the one commit over the git endpoint', () => {
    const plan = checkoutPlan({ source: 'https://reviewos.example/acme/api.git', sha: SHA, onHost: false })

    // The history belongs to the instance, not to this machine.
    expect(plan.commands.join(' ')).toContain('--depth 1')
    expect(plan.commands.at(-1)).toBe('git checkout --quiet FETCH_HEAD')
  })
})

describe('depth', () => {
  test('uses a file:// URL on this host, because git ignores --depth otherwise', () => {
    /*
     * The trap this exists for: git ignores `--depth` on a local-path clone -
     * it hardlinks the object store instead - and prints a warning most people
     * never read. A workflow that asked for a shallow clone and silently got
     * ten years of history is an afternoon of debugging.
     */
    const plan = checkoutPlan({ source: BARE, sha: SHA, onHost: true, options: { depth: 1 } })

    expect(plan.commands.join(' ')).toContain(`'file://${BARE}'`)
    expect(plan.commands.join(' ')).toContain('--depth 1')
    expect(plan.summary).toContain('depth 1')
  })

  test('and zero means all of it, which is the default rather than an error', () => {
    const plan = checkoutPlan({ source: BARE, sha: SHA, onHost: true, options: { depth: 0 } })

    expect(plan.commands[0]).toContain('git clone')
    expect(plan.commands.join(' ')).not.toContain('file://')
  })
})

describe('sparse paths', () => {
  test('are set before anything is fetched, in cone mode', () => {
    const plan = checkoutPlan({
      source: BARE,
      sha: SHA,
      onHost: true,
      options: { sparse: ['packages/api', 'packages/core'] },
    })

    const set = plan.commands.findIndex(one => one.startsWith('git sparse-checkout set'))
    const checkout = plan.commands.findIndex(one => one.startsWith('git checkout'))

    // After that order the working tree would already hold everything, which is
    // the cost the option exists to avoid.
    expect(set).toBeGreaterThan(-1)
    expect(set).toBeLessThan(checkout)
    expect(plan.commands[set]).toBe(`git sparse-checkout set 'packages/api' 'packages/core'`)

    /*
     * Cone mode rather than the pattern language, which is a gitignore dialect
     * that behaves differently from every other glob in a workflow file - and a
     * sparse checkout that quietly matched the wrong set is a build against the
     * wrong tree.
     */
    expect(plan.commands.join(' ')).toContain('--cone')
  })
})

describe('submodules and LFS', () => {
  test('submodules are shallow, and recursive only when asked', () => {
    const top = checkoutPlan({ source: BARE, sha: SHA, onHost: true, options: { submodules: true } })
    const all = checkoutPlan({ source: BARE, sha: SHA, onHost: true, options: { submodules: 'recursive' } })

    expect(top.commands.at(-1)).toContain('git submodule update --init --depth 1')
    expect(top.commands.at(-1)).not.toContain('--recursive')
    expect(all.commands.at(-1)).toContain('--recursive')
  })

  test('LFS is pulled after the checkout rather than during the clone', () => {
    // So a repository whose LFS objects are missing still produces a working
    // tree with pointer files in it - a failure somebody can read - rather than
    // a clone that dies with nothing on disk.
    const plan = checkoutPlan({ source: BARE, sha: SHA, onHost: true, options: { lfs: true } })

    expect(plan.commands.at(-1)).toBe('git lfs pull')
    expect(plan.commands.findIndex(one => one.startsWith('git checkout')))
      .toBeLessThan(plan.commands.length - 1)
  })
})

describe('no checkout at all', () => {
  test('is no commands, and says why', () => {
    // A job that only calls an API or unblocks something. An empty workspace
    // with no explanation is the first thing somebody blames when a step cannot
    // find a file.
    const plan = checkoutPlan({ source: BARE, sha: SHA, onHost: true, options: { skip: true } })

    expect(plan.commands).toEqual([])
    expect(plan.summary).toContain('asked for no checkout')
  })
})
