/**
 * The hooks every repository runs, and how they reach the application.
 *
 * One shared directory, pointed at by `core.hooksPath` on each repository,
 * rather than a copy of the script inside every `.git/hooks`. Copies drift: an
 * instance that has been running for a year would have as many versions of the
 * hook as it has had upgrades, and the ones that never got rewritten would be
 * the repositories nobody pushes to - which is exactly where a silent failure
 * goes unnoticed longest.
 *
 * ## Why a hook rather than watching the refs
 *
 * The application spawns `git receive-pack` itself, so it could snapshot the
 * refs before and after and diff them. That is simpler and it is wrong in two
 * ways that matter: two pushes to one repository interleave, and the answer
 * only exists for pushes that arrive over HTTP. A hook is handed the exact
 * updates by git, and it fires for a push over SSH and for one made on the
 * server by hand.
 *
 * ## Why the hook is trusted, and how far
 *
 * It posts to the application over HTTP with a shared secret, which means the
 * endpoint is reachable by anything that learns the secret. So the secret gets
 * it *heard*, and nothing more: every ref line is re-parsed and shape-checked
 * (`./push.ts`), the repository is looked up by its path on disk rather than
 * taken from the request, and the work happens against what git says the
 * repository now contains rather than against what the request claimed.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runGit } from './git'

/** Where the shared hooks live, relative to the project. */
export const HOOK_DIRECTORY = 'storage/git-hooks'

/** The environment variable both halves read the shared secret from. */
export const HOOK_SECRET_ENV = 'GIT_HOOK_SECRET'

/**
 * A stored `disk_path` as an absolute path, and as the relative form.
 *
 * Rows carry both shapes. The column is documented as relative to the
 * repository root, and most rows are, but some were written absolute - so a
 * lookup that assumes either one silently misses the other half of the table.
 * Both are derived here, once, rather than at each of the three call sites that
 * would otherwise each get it slightly wrong.
 */
export function repositoryPaths(diskPath: string, root = 'storage/repos'): { absolute: string, relative: string } {
  const trimmed = String(diskPath ?? '').replace(/\/+$/, '')
  const marker = `${root}/`
  const relative = trimmed.includes(marker) ? trimmed.slice(trimmed.lastIndexOf(marker) + marker.length) : trimmed

  return {
    absolute: trimmed.startsWith('/') ? trimmed : resolve(process.cwd(), root, relative),
    relative,
  }
}

/**
 * The repository a hook ran in.
 *
 * Both endpoints and the job resolve a `GIT_DIR` to a row, and all three have
 * to do it the same way or they disagree about which repository a push touched
 * - which is exactly what happened: the gate looked up only the relative path
 * and so allowed every push into a repository whose row stores an absolute one,
 * including the ones a branch rule was supposed to refuse.
 *
 * Both shapes are tried, because both are in the table.
 */
export async function repositoryByGitDir(gitDir: string): Promise<any | null> {
  const { absolute, relative } = repositoryPaths(gitDir)

  for (const candidate of [relative, absolute]) {
    if (!candidate)
      continue

    const row = await db
      .selectFrom('repositories')
      .selectAll()
      .where('disk_path', '=', candidate)
      .executeTakeFirst()

    if (row)
      return row
  }

  return null
}

/** Where the hooks post. Root-mounted, like the wire protocol they follow. */
export const HOOK_ENDPOINT = '/internal/git/post-receive'
export const GATE_ENDPOINT = '/internal/git/pre-receive'

/**
 * The secret, or null when the instance has not been given one.
 *
 * Null disables the endpoint rather than defaulting to something: a default
 * shared secret is a published shared secret, and this endpoint turns a request
 * into a job that reads a repository.
 */
export function hookSecret(): string | null {
  const value = String(process.env[HOOK_SECRET_ENV] ?? '').trim()

  return value.length >= 16 ? value : null
}

/**
 * Where the application answers, as the hook will see it.
 *
 * The hook runs on the same machine, so this is a loopback address by default
 * rather than the public URL: a push should not depend on the instance being
 * able to resolve and reach its own hostname from the inside, which is exactly
 * the thing that breaks behind a load balancer.
 */
export function hookUrl(endpoint: string = HOOK_ENDPOINT): string {
  const base = String(process.env.GIT_HOOK_URL ?? '').trim()
  if (base)
    return base.replace(/\/+$/, '') + endpoint

  const port = String(process.env.PORT ?? process.env.APP_PORT ?? '3000').trim()

  return `http://127.0.0.1:${port}${endpoint}`
}

/**
 * The post-receive script.
 *
 * Written in Bun rather than as a shell script with `curl`, because Bun is the
 * one runtime this application is guaranteed to have and `curl` is not
 * installed everywhere. It is generated rather than committed as a file so the
 * URL and the directory cannot drift from what the application believes.
 *
 * The script does as little as possible and never fails the push. A push that
 * git accepted has landed: the commits are on disk, and refusing to exit zero
 * afterwards would print an alarming error about work that succeeded. If the
 * application is down, the refs are still right and the consequence is a
 * missing timeline entry - so the failure is reported on stderr, where git
 * shows it to the pusher, and the hook exits zero anyway.
 */
export function postReceiveScript(url: string): string {
  return `#!/usr/bin/env bun
// Generated by app/Actions/Git/hooks.ts. Do not edit: it is rewritten on every
// repository creation and by \`buddy git:hooks\`.
//
// Reads git's ref updates on stdin and posts them to the application. Never
// fails the push: git has already accepted the commits by the time this runs,
// and exiting non-zero would print an error about work that succeeded.

const chunks = []
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
const body = Buffer.concat(chunks).toString('utf8')

// Which repository this is. git sets \`GIT_DIR\` to \`.\` and chdirs into the
// repository before running a hook, so the variable on its own is useless and
// has to be resolved against the working directory - a bare \`.\` reaches the
// application as a path that matches no repository at all, and the push is
// recorded against nothing while every part of it reports success.
//
// The application still resolves this to a row itself rather than trusting a
// name in the request.
const gitDir = require('node:path').resolve(process.cwd(), process.env.GIT_DIR ?? '.')

try {
  const response = await fetch(${JSON.stringify(url)}, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Git-Hook-Secret': process.env.${HOOK_SECRET_ENV} ?? '',
    },
    body: JSON.stringify({ gitDir, updates: body }),
    signal: AbortSignal.timeout(5000),
  })

  if (!response.ok)
    console.error(\`push recorded on disk, but the forge answered \${response.status}\`)
}
catch (error) {
  console.error(\`push recorded on disk, but the forge could not be reached: \${error}\`)
}
`
}

/**
 * The pre-receive script: the one that can still say no.
 *
 * Everything about it is the opposite of `post-receive`. It runs *before* git
 * writes anything, a non-zero exit refuses the whole push, and it therefore has
 * to be conservative about failure in the other direction: if the application
 * cannot be reached, the push is allowed. A forge that stops accepting pushes
 * because its web process restarted is a forge people work around by pushing
 * somewhere else, and branch protection is not a security boundary - it is a
 * guard rail against a mistake, and the mistake it prevents is rarer than the
 * outage it would otherwise cause.
 *
 * The timeout is short for the same reason: the pusher is waiting.
 */
export function preReceiveScript(url: string): string {
  return `#!/usr/bin/env bun
// Generated by app/Actions/Git/hooks.ts. Do not edit: it is rewritten on every
// repository creation and by \`buddy git:hooks\`.
//
// Asks the application whether this push may land. A non-zero exit refuses the
// whole push, so anything that is not an explicit refusal allows it: branch
// protection is a guard rail against a mistake, and an unreachable web process
// must not stop people working.

const chunks = []
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
const body = Buffer.concat(chunks).toString('utf8')

const gitDir = require('node:path').resolve(process.cwd(), process.env.GIT_DIR ?? '.')

try {
  const response = await fetch(${JSON.stringify(url)}, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Git-Hook-Secret': process.env.${HOOK_SECRET_ENV} ?? '',
    },
    body: JSON.stringify({ gitDir, updates: body }),
    signal: AbortSignal.timeout(3000),
  })

  if (!response.ok) process.exit(0)

  const decision = await response.json()
  if (decision?.ok !== false) process.exit(0)

  for (const refusal of decision.refused ?? [])
    console.error(refusal.reason)

  console.error('')
  console.error('This push was refused by a branch protection rule.')
  process.exit(1)
}
catch {
  // Unreachable, slow, or answering nonsense. Allow the push.
  process.exit(0)
}
`
}

/**
 * Write the shared hooks directory.
 *
 * Idempotent, and safe to run on every boot: the scripts are generated from the
 * current configuration, so an instance whose URL changed gets correct hooks
 * without anybody remembering to regenerate them.
 */
export async function installHooks(root = HOOK_DIRECTORY): Promise<{ ok: boolean, path: string, error?: string }> {
  const directory = resolve(process.cwd(), root)

  try {
    await mkdir(directory, { recursive: true })

    const scripts: Array<[string, string]> = [
      ['post-receive', postReceiveScript(hookUrl(HOOK_ENDPOINT))],
      ['pre-receive', preReceiveScript(hookUrl(GATE_ENDPOINT))],
    ]

    for (const [name, contents] of scripts) {
      const script = join(directory, name)
      await writeFile(script, contents, 'utf8')
      // git will not run a hook it cannot execute, and says nothing at all
      // when it skips one.
      await chmod(script, 0o755)
    }

    return { ok: true, path: directory }
  }
  catch (error) {
    return { ok: false, path: directory, error: String(error) }
  }
}

/**
 * Point one repository at the shared hooks.
 *
 * An absolute path, because git resolves `core.hooksPath` relative to the
 * repository rather than to the working directory of whatever set it.
 */
export async function useSharedHooks(repositoryPath: string, root = HOOK_DIRECTORY): Promise<boolean> {
  const directory = resolve(process.cwd(), root)
  const result = await runGit(repositoryPath, ['config', 'core.hooksPath', directory])

  return result.ok
}
