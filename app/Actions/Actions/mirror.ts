/**
 * Mirroring the actions a repository actually uses.
 *
 * Two problems with one answer. A fleet of runners each fetching
 * `actions/checkout@v4` is the same clone happening ten times, and an instance
 * whose upstream host is unreachable is an instance where nothing builds. Both
 * end when the actions live here.
 *
 * **What is mirrored is what is used**, read out of the workflow versions this
 * instance has already parsed rather than from a list somebody maintains. A
 * list drifts the moment a workflow changes, and the failure of a stale list is
 * a build that breaks because the one action nobody added is the one it needed.
 *
 * Served back over the ordinary git protocol
 * ([`routes/actions.ts`](../../../routes/actions.ts)), so a runner points its
 * origins map at this instance and everything else about fetching stays exactly
 * as it was.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { db } from '@stacksjs/database'
import type { ActionPolicy } from '../Runner/actionRef'
import { checkPolicy, parseActionRef } from '../Runner/actionRef'
import { actionPath } from './store'

export interface UsedAction {
  host: string
  repository: string
  /** Every reference seen for this repository, so a mirror covers all of them. */
  refs: string[]
  /** Which workflows asked for it, for an interface that explains the mirror. */
  workflows: string[]
}

/**
 * The remote actions the instance's active workflows refer to.
 *
 * Read from the steps of the newest version of each active workflow. An older
 * version's actions are deliberately not mirrored: a run of an old definition
 * is a rerun, and a rerun of something nobody has used for months is not worth
 * holding a copy of every action it ever mentioned.
 */
export async function usedActions(policy: ActionPolicy): Promise<UsedAction[]> {
  const steps = await db
    .selectFrom('workflow_version_steps')
    .innerJoin('workflow_version_jobs', 'workflow_version_jobs.id', '=', 'workflow_version_steps.workflow_version_job_id')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_version_jobs.workflow_version_id')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select([
      'workflow_version_steps.uses as uses',
      'workflows.path as workflow',
      'workflows.state as state',
    ])
    .where('workflows.state', '=', 'active')
    .execute()

  const found = new Map<string, UsedAction>()

  for (const step of steps) {
    const uses = String(step.uses ?? '').trim()

    if (!uses)
      continue

    const reference = parseActionRef(uses)

    if (reference.kind !== 'remote' || !reference.repository)
      continue

    // Only what this instance would actually run. Mirroring an action the
    // policy refuses is fetching code nobody is allowed to execute, which is
    // the definition of a pointless network request.
    if (!checkPolicy(reference, policy).allowed)
      continue

    const host = reference.host ?? policy.defaultHost

    if (!host)
      continue

    const key = `${host}/${reference.repository}`
    const existing = found.get(key) ?? { host, repository: reference.repository, refs: [], workflows: [] }

    if (reference.ref && !existing.refs.includes(reference.ref))
      existing.refs.push(reference.ref)

    const workflow = String(step.workflow ?? '')

    if (workflow && !existing.workflows.includes(workflow))
      existing.workflows.push(workflow)

    found.set(key, existing)
  }

  return [...found.values()]
}

export interface MirrorResult {
  ok: boolean
  host: string
  repository: string
  /** Whether this created the mirror rather than updating one. */
  created: boolean
  reason: string
}

export interface MirrorOptions {
  root?: string
  /** Where a host's repositories actually live, for an instance behind a proxy. */
  origins?: Record<string, string>
  timeoutMs?: number
}

/**
 * Mirror one action repository, or update the mirror that exists.
 *
 * A bare mirror with `--mirror` refs, so every tag and branch a workflow might
 * name is present: a mirror that holds `v4` and not `v4.1.0` is one that works
 * until somebody pins more precisely, which is the worst moment for it to stop.
 */
export async function mirrorAction(
  host: string,
  repository: string,
  options: MirrorOptions = {},
): Promise<MirrorResult> {
  const resolved = actionPath(host, repository, options.root)

  if (!resolved.ok || !resolved.path)
    return { ok: false, host, repository, created: false, reason: resolved.reason }

  const origin = options.origins?.[host.toLowerCase()] ?? options.origins?.['*'] ?? `https://${host}`
  const url = `${origin.replace(/\/$/, '')}/${repository}.git`
  const existing = existsSync(resolved.path)

  mkdirSync(dirname(resolved.path), { recursive: true })

  const command = existing
    // `--prune` so a tag deleted upstream disappears here too. A mirror that
    // only ever grows will happily serve a tag its origin has retracted, which
    // is the one case where being helpful is being wrong.
    ? ['git', '--git-dir', resolved.path, 'remote', 'update', '--prune']
    : ['git', 'clone', '--mirror', '--quiet', url, resolved.path]

  const result = await run(command, options.timeoutMs ?? 300_000)

  if (!result.ok) {
    return {
      ok: false,
      host,
      repository,
      created: false,
      reason: `${existing ? 'updating' : 'mirroring'} \`${repository}\` from ${host} failed: ${result.output.trim().split('\n').pop() ?? 'git failed'}`,
    }
  }

  return {
    ok: true,
    host,
    repository,
    created: !existing,
    reason: existing ? 'updated' : 'mirrored',
  }
}

/** Mirror everything the instance's workflows use, and say what happened. */
export async function mirrorUsedActions(
  policy: ActionPolicy,
  options: MirrorOptions = {},
): Promise<{ mirrored: number, updated: number, failed: MirrorResult[] }> {
  const used = await usedActions(policy)

  let mirrored = 0
  let updated = 0
  const failed: MirrorResult[] = []

  for (const action of used) {
    const result = await mirrorAction(action.host, action.repository, options)

    if (!result.ok) {
      /*
       * One action failing does not stop the rest. An upstream that is down is
       * the reason this exists, and a sweep that gives up on the first refusal
       * would be least useful exactly when it is most needed.
       */
      failed.push(result)
      continue
    }

    if (result.created)
      mirrored++
    else
      updated++
  }

  return { mirrored, updated, failed }
}

async function run(command: string[], timeoutMs: number): Promise<{ ok: boolean, output: string }> {
  const child = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      // No prompt, ever. A mirror that asks for a password is a sweep that
      // hangs until somebody notices the scheduler stopped.
      GIT_TERMINAL_PROMPT: '0',
    },
  })

  const timer = setTimeout(() => child.kill(), timeoutMs)

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    return { ok: code === 0, output: `${stdout}${stderr}` }
  }
  finally {
    clearTimeout(timer)
  }
}
