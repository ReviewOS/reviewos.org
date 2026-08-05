// What a new repository starts with, and how it gets there.
//
// The licence texts are checked for being *exact*, because a licence with a
// word changed is not the licence it claims to be. Everything else is checked
// for the one property that matters more than the contents: asking for nothing
// produces nothing, so a repository created to receive an existing history has
// no commit of its own to reject the first push with.

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBare } from '../../app/Actions/Git/git'
import { writeInitialCommit } from '../../app/Actions/Repo/initialCommit'
import {
  GITIGNORES,
  gitignoreKey,
  initialCommitMessage,
  LICENSES,
  licenseKey,
  licenseText,
  renderReadme,
  scaffoldFiles,
} from '../../app/Actions/Repo/scaffold'

describe('scaffoldFiles', () => {
  /**
   * The default, and the reason it is the default: a repository created to
   * receive an existing history must be empty, or the first push is a
   * non-fast-forward rejection against a commit nobody made.
   */
  test('asking for nothing produces nothing', () => {
    expect(scaffoldFiles({ repository: 'app' })).toEqual([])
    expect(scaffoldFiles({ repository: 'app', readme: false, gitignore: null, license: null })).toEqual([])
  })

  test('produces the three files in a fixed order', () => {
    const files = scaffoldFiles({
      repository: 'app',
      description: 'A thing',
      readme: true,
      gitignore: 'node',
      license: 'mit',
      holder: 'Ada',
      year: 2026,
    })

    expect(files.map(file => file.path)).toEqual(['README.md', '.gitignore', 'LICENSE'])
  })

  test('every file has contents, because an empty file in a first commit is a bug', () => {
    const files = scaffoldFiles({ repository: 'app', readme: true, gitignore: 'bun', license: 'isc', year: 2026 })

    expect(files.every(file => file.content.trim().length > 0)).toBe(true)
  })

  test('an unknown gitignore or licence is skipped rather than guessed at', () => {
    const files = scaffoldFiles({ repository: 'app', gitignore: 'cobol', license: 'wtfpl' })

    expect(files).toEqual([])
  })

  test('names are matched without case, the way people type them', () => {
    expect(scaffoldFiles({ repository: 'app', license: 'MIT', year: 2026 })).toHaveLength(1)
    expect(scaffoldFiles({ repository: 'app', gitignore: 'Node' })).toHaveLength(1)
  })
})

describe('renderReadme', () => {
  test('is the name, and the description when there is one', () => {
    expect(renderReadme('app', 'Does the thing')).toBe('# app\n\nDoes the thing\n')
    expect(renderReadme('app', '')).toBe('# app\n')
    expect(renderReadme('app', null)).toBe('# app\n')
  })

  /** Headings somebody has to delete never get deleted. */
  test('has no sections nobody asked for', () => {
    expect(renderReadme('app', 'x')).not.toContain('## ')
  })
})

describe('the licences', () => {
  test('every one fills in the year and the holder', () => {
    for (const key of Object.keys(LICENSES)) {
      const text = licenseText(key, 'Ada Lovelace', 2026)!

      expect(text, key).not.toContain('{{')
      // The Unlicense has no copyright line by design.
      if (key !== 'unlicense') {
        expect(text, key).toContain('2026')
        expect(text, key).toContain('Ada Lovelace')
      }
    }
  })

  /**
   * A copyright line naming nobody is the one part of a licence that has to be
   * right, so an absent holder falls back rather than leaving a blank.
   */
  test('an empty holder does not leave a blank copyright line', () => {
    const text = licenseText('mit', '   ', 2026)!

    expect(text).toContain('Copyright (c) 2026 the repository owners')
  })

  test('MIT is the MIT text, word for word', () => {
    const text = licenseText('mit', 'Ada', 2026)!

    expect(text).toStartWith('MIT License\n\nCopyright (c) 2026 Ada\n')
    expect(text).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy')
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND')
    expect(text).toContain('The above copyright notice and this permission notice shall be included in all')
  })

  test('the BSD licences carry their distinguishing clause', () => {
    expect(licenseText('bsd-3-clause', 'Ada', 2026)!).toContain('Neither the name of the copyright holder')
    expect(licenseText('bsd-2-clause', 'Ada', 2026)!).not.toContain('Neither the name of the copyright holder')
  })

  test('the Unlicense is a dedication rather than a grant', () => {
    expect(licenseText('unlicense', 'Ada', 2026)!).toContain('released into the public domain')
  })

  /**
   * The long licences are absent on purpose. Typing Apache-2.0 or a GPL from
   * memory is how a repository ends up carrying a licence that is subtly not
   * the licence, so they are on the roadmap as checked-in copies instead.
   */
  test('offers only licences short enough to have been reproduced exactly', () => {
    expect(licenseKey('apache-2.0')).toBeNull()
    expect(licenseKey('gpl-3.0')).toBeNull()
    expect(Object.keys(LICENSES).sort()).toEqual(['bsd-2-clause', 'bsd-3-clause', 'isc', 'mit', 'unlicense'])
  })

  test('an unknown key is null rather than a default licence', () => {
    expect(licenseKey('')).toBeNull()
    expect(licenseKey('mit-ish')).toBeNull()
    expect(licenseText('nope', 'Ada', 2026)).toBeNull()
  })
})

describe('the gitignore templates', () => {
  test('each one ignores its own build output', () => {
    expect(GITIGNORES.node!.content).toContain('node_modules/')
    expect(GITIGNORES.python!.content).toContain('__pycache__/')
    expect(GITIGNORES.go!.content).toContain('bin/')
    expect(GITIGNORES.rust!.content).toContain('target/')
  })

  test('every one keeps a .env out of the repository', () => {
    for (const [key, template] of Object.entries(GITIGNORES))
      expect(template.content, key).toContain('.env')
  })

  test('an unknown template is null', () => {
    expect(gitignoreKey('perl')).toBeNull()
    expect(gitignoreKey('')).toBeNull()
  })
})

describe('initialCommitMessage', () => {
  test('says what it added', () => {
    expect(initialCommitMessage([{ path: 'README.md', content: '' }])).toBe('Add README.md')
    expect(initialCommitMessage([
      { path: 'README.md', content: '' },
      { path: '.gitignore', content: '' },
      { path: 'LICENSE', content: '' },
    ])).toBe('Add README.md, .gitignore and LICENSE')
  })
})

/** The plumbing, against a real bare repository. */
describe('writeInitialCommit', () => {
  const author = { name: 'ada', email: 'ada@users.noreply.localhost' }

  function withRepository<T>(run: (bare: string) => T | Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-scaffold-'))

    return (async () => {
      try {
        const bare = join(root, 'repo.git')
        await initBare(bare, 'main')
        return await run(bare)
      }
      finally {
        rmSync(root, { recursive: true, force: true })
      }
    })()
  }

  function git(bare: string, ...args: string[]): string {
    const result = spawnSync('git', ['--git-dir', bare, ...args])
    if (result.status !== 0)
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout.toString()
  }

  test('commits the files onto the branch, in a repository with no worktree', async () => {
    await withRepository(async (bare) => {
      const files = scaffoldFiles({ repository: 'app', readme: true, gitignore: 'bun', license: 'mit', holder: 'Ada', year: 2026 })
      const written = await writeInitialCommit(bare, 'main', files, author)

      expect(written.ok).toBe(true)
      expect(written.sha).toMatch(/^[0-9a-f]{40}$/)

      expect(git(bare, 'ls-tree', '--name-only', 'main').trim().split('\n').sort())
        .toEqual(['.gitignore', 'LICENSE', 'README.md'])
      expect(git(bare, 'cat-file', 'blob', 'main:README.md')).toBe('# app\n')
      expect(git(bare, 'cat-file', 'blob', 'main:LICENSE')).toContain('Copyright (c) 2026 Ada')
    })
  })

  test('the branch points at the commit, so a clone checks it out', async () => {
    await withRepository(async (bare) => {
      const written = await writeInitialCommit(bare, 'main', [{ path: 'a.txt', content: 'a\n' }], author)

      expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(written.sha)
      expect(git(bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('Add a.txt')
    })
  })

  /**
   * Without an explicit identity git assembles one from the host's user and
   * hostname, so every repository's first commit would be authored by the
   * account the server runs as - wrong, and a small disclosure about the host.
   */
  test('the commit is authored by the person, not by the server process', async () => {
    await withRepository(async (bare) => {
      await writeInitialCommit(bare, 'main', [{ path: 'a.txt', content: 'a\n' }], author)

      expect(git(bare, 'log', '-1', '--format=%an <%ae>', 'main').trim()).toBe('ada <ada@users.noreply.localhost>')
      expect(git(bare, 'log', '-1', '--format=%cn <%ce>', 'main').trim()).toBe('ada <ada@users.noreply.localhost>')
    })
  })

  test('a branch that already has commits is left alone', async () => {
    await withRepository(async (bare) => {
      const first = await writeInitialCommit(bare, 'main', [{ path: 'a.txt', content: 'a\n' }], author)
      const second = await writeInitialCommit(bare, 'main', [{ path: 'b.txt', content: 'b\n' }], author)

      expect(second.ok).toBe(false)
      expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(first.sha)
    })
  })

  test('nothing to commit is refused rather than producing an empty commit', async () => {
    await withRepository(async (bare) => {
      expect(await writeInitialCommit(bare, 'main', [], author)).toMatchObject({ ok: false })
    })
  })

  test('a name people actually use for a default branch works too', async () => {
    await withRepository(async (bare) => {
      const written = await writeInitialCommit(bare, 'trunk', [{ path: 'a.txt', content: 'a\n' }], author)

      expect(written.ok).toBe(true)
      expect(git(bare, 'rev-parse', 'refs/heads/trunk').trim()).toBe(written.sha)
    })
  })
})
