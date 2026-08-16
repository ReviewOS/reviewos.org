// Whether a push starts a run.
//
// The failure mode here has no symptom. A filter that matches too little
// produces no run at all, and a run that does not exist leaves nothing on
// screen to look at - so the bug is reported as "CI didn't run" weeks later, by
// somebody who assumed they had configured it wrong. Every case below is one
// where the wrong answer is silent.

import { describe, expect, test } from 'bun:test'
import { globMatches, pathsMatch, patternsFrom, pushStartsRun, refMatches, refName } from '../../app/Actions/Workflow/triggers'

describe('globMatches', () => {
  /*
   * The distinction people get wrong, in the direction that skips the run:
   * `*` stops at a separator and `**` does not.
   */
  test('a single star stays inside one path segment', () => {
    expect(globMatches('docs/*', 'docs/index.md')).toBe(true)
    expect(globMatches('docs/*', 'docs/api/index.md')).toBe(false)
  })

  test('a double star crosses them', () => {
    expect(globMatches('docs/**', 'docs/index.md')).toBe(true)
    expect(globMatches('docs/**', 'docs/api/v2/index.md')).toBe(true)
  })

  test('and matches the directory itself, not only what is under it', () => {
    expect(globMatches('docs/**', 'docs/a')).toBe(true)
  })

  test('a question mark is one character, and not a separator', () => {
    expect(globMatches('v?.ts', 'v1.ts')).toBe(true)
    expect(globMatches('v?.ts', 'v12.ts')).toBe(false)
    expect(globMatches('a?b', 'a/b')).toBe(false)
  })

  test('a dot is a dot rather than any character', () => {
    expect(globMatches('*.ts', 'index.ts')).toBe(true)
    expect(globMatches('*.ts', 'indexXts')).toBe(false)
  })

  test('a pattern anchors at both ends', () => {
    expect(globMatches('src/index.ts', 'src/index.ts')).toBe(true)
    expect(globMatches('index.ts', 'src/index.ts')).toBe(false)
    expect(globMatches('src/index', 'src/index.ts')).toBe(false)
  })
})

describe('refMatches', () => {
  /*
   * `on: push` with no `branches:` runs on every branch. Reading an empty list
   * as "matches nothing" would disable every workflow that never named one,
   * which is most of them.
   */
  test('no filter means every ref', () => {
    expect(refMatches([], 'main')).toBe(true)
    expect(refMatches([], 'anything/at/all')).toBe(true)
  })

  test('a named branch matches itself and not its neighbours', () => {
    expect(refMatches(['main'], 'main')).toBe(true)
    expect(refMatches(['main'], 'maintenance')).toBe(false)
  })

  test('a pattern matches a family of branches', () => {
    expect(refMatches(['release/*'], 'release/1.2')).toBe(true)
    expect(refMatches(['release/*'], 'release/1.2/hotfix')).toBe(false)
    expect(refMatches(['release/**'], 'release/1.2/hotfix')).toBe(true)
  })

  test('an exclusion wins over an inclusion, which is Actions\' precedence', () => {
    expect(refMatches(['release/*', '!release/experimental'], 'release/1.2')).toBe(true)
    expect(refMatches(['release/*', '!release/experimental'], 'release/experimental')).toBe(false)
  })

  test('and exclusions on their own include everything else', () => {
    expect(refMatches(['!wip/*'], 'main')).toBe(true)
    expect(refMatches(['!wip/*'], 'wip/thing')).toBe(false)
  })
})

describe('pathsMatch', () => {
  test('no filter means any change will do', () => {
    expect(pathsMatch([], ['anything.txt'])).toBe(true)
  })

  test('one matching path in the push is enough', () => {
    expect(pathsMatch(['src/**'], ['README.md', 'src/index.ts'])).toBe(true)
  })

  test('and none of them matching is not', () => {
    expect(pathsMatch(['src/**'], ['README.md', 'docs/a.md'])).toBe(false)
  })

  /*
   * These two look alike and are opposites: an empty *filter* means the
   * workflow does not filter by path, and an empty *change set* means the push
   * touched nothing the workflow watches.
   */
  test('an empty filter and an empty push are not the same question', () => {
    expect(pathsMatch([], [])).toBe(true)
    expect(pathsMatch(['src/**'], [])).toBe(false)
  })

  test('an exclusion removes a path from consideration', () => {
    expect(pathsMatch(['**', '!docs/**'], ['docs/a.md'])).toBe(false)
    expect(pathsMatch(['**', '!docs/**'], ['docs/a.md', 'src/a.ts'])).toBe(true)
  })
})

describe('refName', () => {
  test('reads a branch and a tag, and refuses anything else', () => {
    expect(refName('refs/heads/main')).toEqual({ kind: 'branch', name: 'main' })
    expect(refName('refs/tags/v1.0.0')).toEqual({ kind: 'tag', name: 'v1.0.0' })
    expect(refName('refs/pull/12/head')).toBeNull()
  })

  test('and keeps the slashes in a branch name', () => {
    expect(refName('refs/heads/release/1.2')).toEqual({ kind: 'branch', name: 'release/1.2' })
  })
})

describe('pushStartsRun', () => {
  const on = (extra: Record<string, unknown> = {}) => ({ on_push: true, ...extra })

  test('runs on a push to a branch when nothing is filtered', () => {
    const decision = pushStartsRun(on(), { ref: 'refs/heads/main' })

    expect(decision.run).toBe(true)
    expect(decision.reason).toContain('main')
  })

  test('does not run a workflow that has no push trigger', () => {
    expect(pushStartsRun({ on_push: false }, { ref: 'refs/heads/main' }).run).toBe(false)
  })

  test('does not run on a deletion, which introduces no commits', () => {
    const decision = pushStartsRun(on(), { ref: 'refs/heads/main', deleted: true })

    expect(decision.run).toBe(false)
    expect(decision.reason).toContain('deleted')
  })

  test('honours a branch filter', () => {
    expect(pushStartsRun(on({ push_branches: 'main' }), { ref: 'refs/heads/main' }).run).toBe(true)
    expect(pushStartsRun(on({ push_branches: 'main' }), { ref: 'refs/heads/other' }).run).toBe(false)
  })

  /*
   * Tags are opted into. A workflow that names branches and not tags is asking
   * for branches, and the other reading sends every release tag through a
   * workflow written for `main`.
   */
  test('a tag push does not run a workflow that only filters branches', () => {
    const decision = pushStartsRun(on({ push_branches: 'main' }), { ref: 'refs/tags/v1.0.0' })

    expect(decision.run).toBe(false)
    expect(decision.reason).toContain('tag')
  })

  test('but does when the workflow asks for tags', () => {
    expect(pushStartsRun(on({ push_tags: 'v*' }), { ref: 'refs/tags/v1.0.0' }).run).toBe(true)
    expect(pushStartsRun(on({ push_tags: 'v*' }), { ref: 'refs/tags/nightly' }).run).toBe(false)
  })

  test('honours a path filter against what the push changed', () => {
    const version = on({ push_paths: 'src/**' })

    expect(pushStartsRun(version, { ref: 'refs/heads/main', changed: ['src/a.ts'] }).run).toBe(true)
    expect(pushStartsRun(version, { ref: 'refs/heads/main', changed: ['README.md'] }).run).toBe(false)
  })

  /*
   * Erring towards running. A missed run on a push that did touch the paths is
   * a broken product; an extra run on one that did not is a wasted minute, and
   * it is visible - somebody can see a run that should not have happened, and
   * nobody can see one that should have.
   */
  test('runs when the changed paths are unknown and the workflow filters on them', () => {
    const decision = pushStartsRun(on({ push_paths: 'src/**' }), { ref: 'refs/heads/main' })

    expect(decision.run).toBe(true)
    expect(decision.reason).toContain('nothing we can see')
  })

  test('a ref that is neither branch nor tag starts nothing', () => {
    expect(pushStartsRun(on(), { ref: 'refs/pull/12/head' }).run).toBe(false)
  })

  test('every refusal says why, because a run that did not happen is invisible', () => {
    const refusals = [
      pushStartsRun({ on_push: false }, { ref: 'refs/heads/main' }),
      pushStartsRun(on(), { ref: 'refs/heads/main', deleted: true }),
      pushStartsRun(on({ push_branches: 'main' }), { ref: 'refs/heads/other' }),
      pushStartsRun(on({ push_paths: 'src/**' }), { ref: 'refs/heads/main', changed: ['README.md'] }),
    ]

    for (const decision of refusals) {
      expect(decision.run).toBe(false)
      expect(decision.reason.length).toBeGreaterThan(10)
    }
  })
})

describe('patternsFrom', () => {
  test('reads one pattern per line and ignores the blank ones', () => {
    expect(patternsFrom('main\n\n  release/*  \n')).toEqual(['main', 'release/*'])
  })

  test('and treats absent as no filter rather than as one empty pattern', () => {
    expect(patternsFrom(null)).toEqual([])
    expect(patternsFrom('')).toEqual([])
    expect(patternsFrom('   ')).toEqual([])
  })
})

describe('the negative filters', () => {
  /*
   * `branches-ignore` is not `branches` inverted: it changes the default. With
   * `branches`, a branch runs only if it matches; with `branches-ignore`, every
   * branch runs except the ones named. A workflow with only an ignore list and
   * no positive one used to match nothing, so it never ran at all.
   */
  test('branches-ignore runs everything it does not name', () => {
    const version = { on_push: true, push_branches_ignore: 'wip/**\nrenovate/**' }

    expect(pushStartsRun(version, { ref: 'refs/heads/main' }).run).toBe(true)
    expect(pushStartsRun(version, { ref: 'refs/heads/feature/thing' }).run).toBe(true)
    expect(pushStartsRun(version, { ref: 'refs/heads/wip/spike' }).run).toBe(false)
    expect(pushStartsRun(version, { ref: 'refs/heads/wip/spike' }).reason).toContain('branches-ignore')
  })

  test('tags-ignore counts as naming tags, so a tag push is not silently dropped', () => {
    // Tags are opted into: a workflow filtering on branches does not run on
    // tags. But `tags-ignore` *is* a tag filter, and reading it as "no tag
    // filter" would mean a workflow written to run on every tag but the
    // release ones never ran on any.
    const version = { on_push: true, push_tags_ignore: 'v*-rc*' }

    expect(pushStartsRun(version, { ref: 'refs/tags/v1.2.0' }).run).toBe(true)
    expect(pushStartsRun(version, { ref: 'refs/tags/v1.2.0-rc1' }).run).toBe(false)
  })

  test('and a push with neither form still runs, as it always did', () => {
    expect(pushStartsRun({ on_push: true }, { ref: 'refs/heads/anything' }).run).toBe(true)
  })
})

describe('paths-ignore', () => {
  /*
   * The rule people rely on: a push that only touches documentation does not
   * start CI. The subtle half is what "only" means.
   */
  test('excludes a push whose every file is ignored', () => {
    const version = { on_push: true, push_paths_ignore: 'docs/**\n**/*.md' }

    expect(pushStartsRun(version, { ref: 'refs/heads/main', changed: ['docs/guide.md', 'README.md'] }).run).toBe(false)
  })

  test('and runs when anything else changed too', () => {
    // One source file alongside a hundred documentation changes is still a
    // source change. The filter is about pushes that are entirely
    // uninteresting, not pushes that contain anything uninteresting.
    const version = { on_push: true, push_paths_ignore: 'docs/**' }

    expect(pushStartsRun(version, { ref: 'refs/heads/main', changed: ['docs/guide.md', 'app/thing.ts'] }).run).toBe(true)
  })

  test('a push with nothing known about it runs, filter or no filter', () => {
    // A missed run on a push that did touch the paths is a broken product; an
    // extra run on one that did not is a wasted minute.
    const version = { on_push: true, push_paths_ignore: 'docs/**' }

    expect(pushStartsRun(version, { ref: 'refs/heads/main', changed: [] }).run).toBe(true)
  })

  test('and the positive form still decides on its own', () => {
    const version = { on_push: true, push_paths: 'app/**' }

    expect(pushStartsRun(version, { ref: 'refs/heads/main', changed: ['app/thing.ts'] }).run).toBe(true)
    expect(pushStartsRun(version, { ref: 'refs/heads/main', changed: ['docs/guide.md'] }).run).toBe(false)
  })
})
