// The two shell commands the runner puts on a job's PATH, executed for real.
//
// They are shell scripts written by TypeScript template literals, which means
// nothing type-checks them: an escape that survives `tsc` and dies in `sh` is
// invisible until a job tries to use it, and then it is a build failure with a
// syntax error from a file nobody knew existed. Writing this test caught
// exactly that - a `\n` inside the template became a real newline in the
// middle of a JavaScript string.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSplitCommand, writeUploadCommand } from '../../app/Actions/Runner/localExecutor'

let directory = ''
let server: any = null
let asked: any = null

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'runner-commands-'))

  // Standing in for the instance, so the test proves the whole path: the
  // script's arguments, its credential, its body, and what it prints.
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      asked = { path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: await request.json() }

      return Response.json({
        items: ['e2e/slow.spec.ts', 'unit/a.test.ts'],
        note: 'No timing history for any of these 3 items.',
        added: [41],
      })
    },
  })
})

afterAll(() => {
  server?.stop?.(true)
  rmSync(directory, { recursive: true, force: true })
})

test('reviewos-split posts the list and prints this node\'s slice', async () => {
  writeSplitCommand(directory, `http://127.0.0.1:${server.port}`, 'job-token-abc')

  const answer = await Bun.$`printf 'e2e/slow.spec.ts\nunit/a.test.ts\nunit/b.test.ts' | ${join(directory, 'reviewos-split')} unit 2 1`.quiet()

  expect(answer.exitCode).toBe(0)
  expect(answer.stdout.toString().trim().split('\n')).toEqual(['e2e/slow.spec.ts', 'unit/a.test.ts'])

  /*
   * The note goes to stderr, which is the difference between a client somebody
   * can pipe into `xargs` and one they cannot. A split computed from no
   * history still has to say so somewhere a person reads.
   */
  expect(answer.stderr.toString()).toContain('No timing history')

  expect(asked.path).toBe('/api/runner/split')
  expect(asked.headers.authorization).toBe('Bearer job-token-abc')
  expect(asked.body).toMatchObject({ suite: 'unit', nodes: 2, index: 1 })
  expect(String(asked.body.items).split('\n')).toHaveLength(3)
})

test('and the credential is in the script rather than in the environment', async () => {
  /*
   * A step that prints its environment, or tars up the workspace, must not
   * carry the job credential with it - so it lives in a file mode 0700 outside
   * the checkout, and this is the assertion that keeps it there.
   */
  const script = await Bun.file(join(directory, 'reviewos-split')).text()

  expect(script).toContain('job-token-abc')
  expect(script).not.toContain('$REVIEWOS_JOB_TOKEN')
})

test('reviewos-upload sends a generated document to the run it belongs to', async () => {
  const path = writeUploadCommand(join(directory, 'workspace'), `http://127.0.0.1:${server.port}`, 'job-token-xyz')

  expect(path).not.toBe('')

  const answer = await Bun.$`printf 'jobs:\n  generated:\n    steps: []\n' | ${join(path, 'reviewos-upload')}`.quiet()

  expect(answer.exitCode).toBe(0)
  expect(asked.path).toBe('/api/runner/upload')
  expect(asked.headers.authorization).toBe('Bearer job-token-xyz')
  expect(String(asked.body.steps)).toContain('generated:')

  rmSync(path, { recursive: true, force: true })
})
