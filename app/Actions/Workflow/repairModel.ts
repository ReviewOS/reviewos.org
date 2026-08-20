/**
 * The parent half of the model boundary.
 *
 * [`repairModelChild.ts`](./repairModelChild.ts) is the other half and explains
 * why there is one. This side decides what crosses: it spawns the child, hands
 * it a prompt and an environment built from an allowlist, waits with a ceiling,
 * and reads one line of JSON back.
 *
 * ## An allowlist, not a denylist
 *
 * `childEnvironment` names what the child gets. The alternative - copy the
 * environment and delete the dangerous keys - is wrong in a way that only shows
 * up later: every secret added to this application afterwards would be one
 * somebody has to remember to add to the deletion list, and the failure is
 * silent and permanent. An allowlist fails the other way. A new variable the
 * model call genuinely needs is a missing feature somebody notices in an hour;
 * a new variable it must not see is handled by nobody doing anything.
 *
 * ## What crosses, and why each one
 *
 * The key, because it is the call. A base URL and the proxy and certificate
 * variables, because an operator behind a corporate proxy or a gateway has a
 * model call that cannot be made without them - and refusing to pass those
 * would not be a security decision, it would be a product that does not work in
 * the environments this is self-hosted into. Nothing else: no `APP_KEY`, no
 * database credentials, no object storage keys, no deploy secrets.
 */

import { join } from 'node:path'
import type { ModelCallReply, ModelCallRequest } from './repairModelChild'
import { repairCallSeconds } from '../../../config/ci-repair'

/**
 * The variables the model call is allowed to see.
 *
 * `ANTHROPIC_API_KEY` is the call itself. The rest are the ones without which a
 * self-hosted instance behind a proxy or a private gateway cannot reach an API
 * at all, which is a different question from whether it should be trusted with
 * a database password.
 */
export const PASSED_TO_MODEL = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const

/**
 * The child's whole environment.
 *
 * Pure, and exported, because this is the security-critical line in the feature
 * and a claim about it should be settled by reading a test rather than by
 * reading a spawn call. `PATH` is set to a fixed minimal value rather than
 * inherited: the child execs nothing, and an inherited `PATH` is a list of
 * directories somebody's shell profile put there.
 */
export function childEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const passed: Record<string, string> = {
    PATH: '/usr/bin:/bin',
  }

  for (const name of PASSED_TO_MODEL) {
    const value = env[name]

    if (typeof value === 'string' && value !== '')
      passed[name] = value
  }

  return passed
}

/** Where the child lives, resolved against this file rather than the working directory. */
export function childScript(): string {
  return join(import.meta.dir, 'repairModelChild.ts')
}

/**
 * Run one model call in its own process.
 *
 * Never throws: every failure comes back as a reply the caller can record,
 * because this sits on the path that has already spent an attempt from a
 * repository's budget and the useful thing to do with a failure is write it
 * down.
 */
export async function callModelInChild(request: ModelCallRequest): Promise<ModelCallReply> {
  const seconds = repairCallSeconds()

  let kill: (() => void) | null = null

  try {
    /*
     * Spawned into a `const` so the options narrow the result: `stdout: 'pipe'`
     * is what tells the types this is a stream to read rather than a file
     * descriptor, and a pre-declared variable loses that.
     */
    const finished = Bun.spawn([process.execPath, childScript()], {
      // The whole point. Everything the control plane holds stays here.
      env: childEnvironment(),
      stdin: new TextEncoder().encode(JSON.stringify(request)),
      stdout: 'pipe',
      stderr: 'pipe',
      // No cwd of its own to inherit meaning from: the child opens no files, and
      // a working directory is a capability it has no use for.
      cwd: '/',
    })

    // Held so the `catch` can end a child that started and then failed us.
    kill = () => finished.kill()

    /*
     * The timer is held so it can be cleared, and that is not tidiness.
     *
     * `Promise.race` settles on whichever finishes first and leaves the other
     * pending - so an uncleared timer keeps the event loop alive for the whole
     * ceiling after every single call. Everything *works*; the process just
     * will not exit, for five minutes, after a repair that took two seconds.
     * In a worker that ends when its work is done that is five idle minutes,
     * and in one that does not it is a leaked closure per repair.
     */
    let timer: ReturnType<typeof setTimeout> | undefined

    const answer = await Promise.race([
      (async () => {
        const text = await new Response(finished.stdout).text()

        await finished.exited

        return text
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), seconds * 1000)
      }),
    ]).finally(() => clearTimeout(timer))

    if (answer === null) {
      /*
       * A model call that never came back holds an attempt open, and the attempt
       * is holding a slot against the fleet ceiling. Killed rather than left,
       * because the ceiling only means something if the things counted against
       * it end.
       */
      finished.kill()

      return { ok: false, error: `the model did not answer within ${seconds} seconds` }
    }

    return readReply(answer)
  }
  catch (error) {
    kill?.()

    return { ok: false, error: `the repair process could not be started: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
  }
}

/**
 * The child's answer, as a reply.
 *
 * Pure, so the parsing has tests. The last non-empty line is taken rather than
 * the whole of stdout: a dependency that prints a deprecation warning on start
 * would otherwise turn every repair into a parse failure, and chasing that down
 * from "the model could not be reached" is an afternoon nobody should spend.
 */
export function readReply(stdout: string): ModelCallReply {
  const lines = String(stdout ?? '').split('\n').map(one => one.trim()).filter(Boolean)
  const last = lines[lines.length - 1]

  if (!last)
    return { ok: false, error: 'the repair process answered nothing' }

  try {
    const parsed = JSON.parse(last)

    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean')
      return parsed as ModelCallReply

    return { ok: false, error: 'the repair process answered something that was not a reply' }
  }
  catch {
    return { ok: false, error: `the repair process answered something that was not JSON: ${last.slice(0, 200)}` }
  }
}
