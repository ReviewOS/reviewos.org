import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesFor, hashFiles, hashFilesIn } from '../../app/Actions/Runner/hashFiles'
import { unfillable } from '../../app/Actions/Runner/localExecutor'
import { evaluateExpression, HASH_FILES, HASH_FILES_REFUSED, interpolate } from '../../app/Actions/Workflow/expression'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

/**
 * `hashFiles()`, on the runner where the checkout is.
 *
 * The expected digests are computed here with `node:crypto`, independently of
 * the implementation, and in the shape Actions documents: the SHA-256 of every
 * matched file's own SHA-256 digest, concatenated in path order. A key written
 * for Actions has to name the same entry here, so "a stable hash" is not the
 * bar - "GitHub's hash" is.
 */

let workspace = ''

function write(path: string, body: string): void {
  mkdirSync(join(workspace, path, '..'), { recursive: true })
  writeFileSync(join(workspace, path), body)
}

/** GitHub's construction, written out by hand. */
function expected(...bodies: string[]): string {
  const combined = createHash('sha256')

  for (const body of bodies)
    combined.update(createHash('sha256').update(body).digest())

  return combined.digest('hex')
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'reviewos-hashfiles-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('hashFiles over a workspace', () => {
  test('one file is the hash of its hash', () => {
    write('bun.lock', 'lock v1')

    expect(hashFiles(workspace, ['bun.lock'])).toBe(expected('lock v1'))
  })

  test('changes when the file does, which is the whole point of a cache key', () => {
    write('bun.lock', 'lock v1')
    const before = hashFiles(workspace, ['bun.lock'])

    write('bun.lock', 'lock v2')

    expect(hashFiles(workspace, ['bun.lock'])).not.toBe(before)
  })

  test('is the empty string when nothing matches', () => {
    expect(hashFiles(workspace, ['bun.lock'])).toBe('')
    expect(hashFiles(workspace, ['**/*.nothing'])).toBe('')
  })

  test('takes several patterns and hashes in path order, whatever order they came in', () => {
    write('b/package.json', 'bee')
    write('a/package.json', 'ay')

    const answer = expected('ay', 'bee')

    expect(hashFiles(workspace, ['b/package.json', 'a/package.json'])).toBe(answer)
    expect(hashFiles(workspace, ['**/package.json'])).toBe(answer)
  })

  test('hashes a file matched by two patterns once', () => {
    write('bun.lock', 'lock')

    expect(hashFiles(workspace, ['bun.lock', '**/bun.lock'])).toBe(expected('lock'))
  })

  test('excludes with `!`, and the last pattern to match decides', () => {
    write('bun.lock', 'root')
    write('node_modules/dep/bun.lock', 'dependency')

    expect(filesFor(workspace, ['**/bun.lock'])).toEqual(['bun.lock', 'node_modules/dep/bun.lock'])
    expect(filesFor(workspace, ['**/bun.lock', '!node_modules/**'])).toEqual(['bun.lock'])
    expect(hashFiles(workspace, ['**/bun.lock', '!node_modules/**'])).toBe(expected('root'))

    // The reverse order puts it back: a later positive pattern wins.
    expect(filesFor(workspace, ['!node_modules/**', '**/bun.lock'])).toEqual(['bun.lock', 'node_modules/dep/bun.lock'])
  })

  test('a directory means everything under it, as @actions/glob reads one', () => {
    write('src/a.ts', 'a')
    write('src/deep/b.ts', 'b')
    write('other.ts', 'o')

    expect(filesFor(workspace, ['src'])).toEqual(['src/a.ts', 'src/deep/b.ts'])
    expect(filesFor(workspace, ['src/'])).toEqual(['src/a.ts', 'src/deep/b.ts'])
  })

  test('matches dotfiles, the way Actions does', () => {
    write('.config/tool.lock', 'dot')

    expect(filesFor(workspace, ['**/*.lock'])).toEqual(['.config/tool.lock'])
  })

  test('never hashes the runner\'s own scratch directory', () => {
    write('bun.lock', 'lock')
    write('.reviewos-runner/step-1/bun.lock', 'changes every job')

    expect(filesFor(workspace, ['**/bun.lock'])).toEqual(['bun.lock'])
  })

  test('reads `./` and an absolute path inside the workspace as the same file', () => {
    write('bun.lock', 'lock')

    expect(hashFiles(workspace, ['./bun.lock'])).toBe(expected('lock'))
    expect(hashFiles(workspace, [join(workspace, 'bun.lock')])).toBe(expected('lock'))
  })

  test('and refuses to look outside it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'reviewos-hashfiles-outside-'))

    try {
      writeFileSync(join(outside, 'secret.lock'), 'not yours')

      expect(hashFiles(workspace, [join(outside, 'secret.lock')])).toBe('')
      expect(hashFiles(workspace, ['../**/secret.lock'])).toBe('')
    }
    finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('follows a symbolic link to a file, and never hashes a directory', () => {
    write('real/bun.lock', 'linked')
    symlinkSync(join(workspace, 'real', 'bun.lock'), join(workspace, 'bun.lock'))

    expect(filesFor(workspace, ['bun.lock'])).toEqual(['bun.lock'])
    expect(filesFor(workspace, ['real'])).toEqual(['real/bun.lock'])
  })

  test('remembers an answer within one context and not across them', () => {
    write('bun.lock', 'one')

    const hasher = hashFilesIn(workspace)
    const first = hasher(['bun.lock'])

    write('bun.lock', 'two')

    // Within one step: the same answer, because nothing ran in between.
    expect(hasher(['bun.lock'])).toBe(first)
    // The next step gets a new context, and reads the files as they are now.
    expect(hashFilesIn(workspace)(['bun.lock'])).toBe(expected('two'))
  })
})

describe('hashFiles in an expression', () => {
  test('is answered when the context carries the workspace', () => {
    write('bun.lock', 'lock')

    const context = { env: { BUN_VERSION: '1.4.2' }, [HASH_FILES]: hashFilesIn(workspace) }

    expect(evaluateExpression('hashFiles(\'bun.lock\')', context).value).toBe(expected('lock'))
    expect(interpolate('node-modules-${{ env.BUN_VERSION }}-${{ hashFiles(\'bun.lock\') }}', context))
      .toBe(`node-modules-1.4.2-${expected('lock')}`)
  })

  test('takes several arguments, including an exclusion', () => {
    write('a.lock', 'a')
    write('vendor/b.lock', 'b')

    const context = { [HASH_FILES]: hashFilesIn(workspace) }

    expect(evaluateExpression('hashFiles(\'**/*.lock\', \'!vendor/**\')', context).value).toBe(expected('a'))
  })

  test('is refused, with the reason, where there is no checkout', () => {
    const result = evaluateExpression('hashFiles(\'bun.lock\')')

    expect(result.ok).toBe(false)
    expect(result.error).toBe(HASH_FILES_REFUSED)
  })

  test('is never left as written by interpolation', () => {
    /*
     * Every other unresolvable expression stays visible. This one would become
     * a cache key that is the same literal text on every run, so the first
     * entry ever saved is restored forever - and nothing looks wrong.
     */
    expect(() => interpolate('key-${{ hashFiles(\'bun.lock\') }}', {})).toThrow(/hashFiles/)
  })

  test('cannot be reached as a value', () => {
    // The hasher sits on a symbol, so nothing a workflow writes can read it.
    const context = { [HASH_FILES]: hashFilesIn(workspace) }

    expect(evaluateExpression('hashFiles', context).value).toBeNull()
  })
})

describe('a step whose expression cannot be filled in', () => {
  test('is reported before it runs, naming the expression', () => {
    const step = { uses: 'actions/cache@v5', with: { path: 'node_modules', key: 'deps-${{ hashFiles(\'bun.lock\') }}' } }

    const refusal = unfillable(step, {})

    expect(refusal).toContain('hashFiles(\'bun.lock\')')
    expect(refusal).toContain('checkout')
  })

  test('and is not reported when the runner can answer it', () => {
    write('bun.lock', 'lock')

    const step = { run: 'echo ${{ hashFiles(\'bun.lock\') }}', env: { KEY: '${{ hashFiles(\'**/bun.lock\') }}' } }

    expect(unfillable(step, { [HASH_FILES]: hashFilesIn(workspace) })).toBeNull()
  })

  test('other unresolvable expressions are left to the step, as before', () => {
    expect(unfillable({ run: 'echo ${{ nonsense(1) }}' }, {})).toBeNull()
  })
})

describe('the parser', () => {
  const job = (extra: string) => `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - run: make test\n`

  test('accepts hashFiles inside a step, where Actions accepts it', () => {
    const result = parseWorkflow(
      'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@v5\n        with:\n          path: node_modules\n          key: deps-${{ hashFiles(\'bun.lock\') }}\n      - if: hashFiles(\'bun.lock\') != \'\'\n        run: bun install\n',
      '.github/workflows/ci.yml',
    )

    expect(result.errors).toEqual([])
  })

  test('refuses it where it would be evaluated before a checkout', () => {
    for (const extra of [
      '    if: hashFiles(\'bun.lock\') != \'\'\n',
      '    concurrency: deploy-${{ hashFiles(\'bun.lock\') }}\n',
      '    env:\n      KEY: ${{ hashFiles(\'bun.lock\') }}\n',
      '    outputs:\n      key: ${{ hashFiles(\'bun.lock\') }}\n',
    ]) {
      const result = parseWorkflow(job(extra), '.github/workflows/ci.yml')

      expect(result.ok).toBe(false)
      expect(result.errors.map(error => error.message).join('\n')).toContain('before there is a checkout')
    }
  })

  test('and at the top of the file', () => {
    const result = parseWorkflow(
      `concurrency:\n  group: \${{ hashFiles('bun.lock') }}\n${job('')}`,
      '.github/workflows/ci.yml',
    )

    expect(result.ok).toBe(false)
    expect(result.errors[0]?.line).toBe(1)
  })
})
