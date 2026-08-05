// The hooks, against a real repository and a real `git push`.
//
// The unit tests either side of this cover the strings: what a ref line means,
// whether a pattern covers a branch. None of that proves the thing that
// actually has to be true - that git *runs* these scripts, that it hands them
// the ref updates on stdin, and that a non-zero exit from the pre-receive hook
// refuses the push rather than being ignored.
//
// git says nothing at all when it skips a hook it cannot execute, so a hook
// that is never run and a hook that always allows are indistinguishable from
// the outside. That is the failure this file exists to catch.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBare } from '../../app/Actions/Git/git'
import { postReceiveScript, preReceiveScript } from '../../app/Actions/Git/hooks'
import { parseRefUpdates } from '../../app/Actions/Git/push'

let root: string
let bare: string
let work: string
let hooks: string
let received: string

function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

function mustGit(cwd: string, ...args: string[]) {
  const result = git(cwd, ...args)
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)

  return result.stdout.toString()
}

/**
 * A hook that writes what git gave it to a file, so the test can read it.
 *
 * Standing in for the generated one, which posts over HTTP. What is under test
 * here is git's side of the contract - that the hook runs at all, and that
 * stdin carries the ref updates - and a file is a far more direct way to
 * observe that than a web server.
 */
function recordingHook(target: string, exitCode = 0): string {
  return `#!/usr/bin/env bun
const chunks = []
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
await Bun.write(${JSON.stringify(target)}, Buffer.concat(chunks).toString('utf8'))
if (${exitCode} !== 0) console.error('remote: refused by the test hook')
process.exit(${exitCode})
`
}

function installHook(name: string, contents: string) {
  const path = join(hooks, name)
  writeFileSync(path, contents, 'utf8')
  chmodSync(path, 0o755)
}

function removeHook(name: string) {
  rmSync(join(hooks, name), { force: true })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-hooks-'))
  bare = join(root, 'demo.git')
  work = join(root, 'work')
  hooks = join(root, 'hooks')
  received = join(root, 'received.txt')

  mkdirSync(hooks, { recursive: true })
  await initBare(bare)

  // The shared directory, exactly as a real repository is pointed at it.
  mustGit(root, '--git-dir', bare, 'config', 'core.hooksPath', hooks)

  mkdirSync(work, { recursive: true })
  mustGit(work, 'init', '--initial-branch=main')
  writeFileSync(join(work, 'README.md'), '# demo\n')
  mustGit(work, 'add', '.')
  mustGit(work, 'commit', '-m', 'first')
  mustGit(work, 'remote', 'add', 'origin', bare)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('post-receive', () => {
  test('git runs it, and stdin carries the ref updates', () => {
    rmSync(received, { force: true })
    installHook('post-receive', recordingHook(received))

    const push = git(work, 'push', 'origin', 'main')
    expect(push.status).toBe(0)

    const updates = parseRefUpdates(require('node:fs').readFileSync(received, 'utf8'))

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ ref: 'refs/heads/main', change: 'created', name: 'main' })
    expect(updates[0]!.after).toMatch(/^[0-9a-f]{40}$/)
  })

  test('a second push reports the range it moved through', () => {
    const before = mustGit(work, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(work, 'README.md'), '# demo\n\nmore\n')
    mustGit(work, 'commit', '-am', 'second')

    rmSync(received, { force: true })
    expect(git(work, 'push', 'origin', 'main').status).toBe(0)

    const [update] = parseRefUpdates(require('node:fs').readFileSync(received, 'utf8'))

    expect(update).toMatchObject({ change: 'updated', before })
  })

  /**
   * The push has landed by the time this hook runs. Refusing afterwards would
   * print an alarming error about work that succeeded, so the generated hook
   * exits zero whatever the application said - and this proves git agrees that
   * a failing post-receive does not undo anything.
   */
  test('a failing post-receive does not fail the push', () => {
    installHook('post-receive', recordingHook(received, 1))
    writeFileSync(join(work, 'README.md'), '# demo\n\nthird\n')
    mustGit(work, 'commit', '-am', 'third')

    expect(git(work, 'push', 'origin', 'main').status).toBe(0)
    expect(mustGit(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main').trim())
      .toBe(mustGit(work, 'rev-parse', 'HEAD').trim())

    installHook('post-receive', recordingHook(received))
  })
})

describe('pre-receive', () => {
  afterAll(() => removeHook('pre-receive'))

  test('a non-zero exit refuses the push, and the ref does not move', () => {
    const landed = mustGit(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main').trim()

    installHook('pre-receive', recordingHook(join(root, 'gate.txt'), 1))
    writeFileSync(join(work, 'README.md'), '# demo\n\nrefused\n')
    mustGit(work, 'commit', '-am', 'refused')

    const push = git(work, 'push', 'origin', 'main')

    expect(push.status).not.toBe(0)
    expect(push.stderr.toString()).toContain('refused by the test hook')
    expect(mustGit(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main').trim()).toBe(landed)
  })

  test('and it sees the same ref updates the post-receive hook would', () => {
    const [update] = parseRefUpdates(require('node:fs').readFileSync(join(root, 'gate.txt'), 'utf8'))

    expect(update).toMatchObject({ ref: 'refs/heads/main', change: 'updated' })
  })

  test('exiting zero lets it through', () => {
    installHook('pre-receive', recordingHook(join(root, 'gate.txt'), 0))

    expect(git(work, 'push', 'origin', 'main').status).toBe(0)
    expect(mustGit(root, '--git-dir', bare, 'rev-parse', 'refs/heads/main').trim())
      .toBe(mustGit(work, 'rev-parse', 'HEAD').trim())
  })
})

/**
 * The generated scripts, checked as text. They cannot be executed here - they
 * post to a running application - but the things most likely to be wrong about
 * them are visible without running: the URL, the secret header, and which way
 * each one exits.
 */
describe('the generated scripts', () => {
  const post = postReceiveScript('http://127.0.0.1:3000/internal/git/post-receive')
  const pre = preReceiveScript('http://127.0.0.1:3000/internal/git/pre-receive')

  test('both are bun scripts git can execute', () => {
    expect(post.startsWith('#!/usr/bin/env bun')).toBe(true)
    expect(pre.startsWith('#!/usr/bin/env bun')).toBe(true)
  })

  /**
   * The one that matters most, and the one that was missing.
   *
   * A generated script that does not parse exits non-zero, and a non-zero
   * pre-receive **refuses the push** - so a typo in a template string does not
   * degrade the feature, it stops everybody from pushing anything. Nothing in
   * the script can catch that either: a syntax error happens before its own
   * `try` exists.
   *
   * These are built by string concatenation, which is exactly the kind of code
   * that breaks silently when somebody edits the middle of it.
   */
  test('both parse, because a script that does not refuses every push', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' })

    for (const [name, script] of [['post-receive', post], ['pre-receive', pre]] as const) {
      expect(() => transpiler.transformSync(script.replace('#!/usr/bin/env bun', '')), name)
        .not.toThrow()
    }
  })

  test('both carry the secret header and the url they were built with', () => {
    for (const script of [post, pre]) {
      expect(script).toContain('X-Git-Hook-Secret')
      expect(script).toContain('GIT_HOOK_SECRET')
    }

    expect(post).toContain('/internal/git/post-receive')
    expect(pre).toContain('/internal/git/pre-receive')
  })

  test('post-receive never refuses, whatever happens', () => {
    expect(post).not.toContain('process.exit(1)')
  })

  /** An unreachable application must not stop people pushing. */
  test('pre-receive refuses only on an explicit refusal', () => {
    expect(pre).toContain('process.exit(1)')
    expect(pre).toContain('if (!response.ok) process.exit(0)')
    expect(pre).toContain('catch')
  })
})
