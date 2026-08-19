/**
 * Reusable workflows: a job that `uses:` another workflow.
 *
 * A calling job has no steps of its own. What runs is the called workflow's
 * jobs, copied into the same run under the caller's name - `deploy / build`,
 * the way Actions names them - so one run still shows everything that happened,
 * which is the property a person reading a failed pipeline needs.
 *
 * **Only workflows registered on this repository can be called, and only the
 * version this instance holds.** A caller resolves against the called
 * workflow's *registered definition*, never against whatever its file says on
 * some other branch. That is the same rule the fork policy applies to a pull
 * request, for the same reason: the tree a run's instructions come from must be
 * one somebody with write access put there.
 */

import { db } from '@stacksjs/database'
import { checkInputs } from './inputs'
import { isTrue } from '../Support/sql'

export interface CallTarget {
  /** The workflow version whose jobs should be copied in. */
  versionId: number
  /** The path it was found at, for the interface. */
  path: string
}

export interface CallResolution {
  ok: boolean
  target: CallTarget | null
  /** The values the called workflow will see, defaults filled in. */
  inputs: Record<string, string>
  /** Why it cannot be called, in words for the person who wrote the file. */
  error: string | null
}

/**
 * How deep a chain of calls may go.
 *
 * Actions allows four levels. The limit exists for the same reason a stack has
 * one: a workflow calling itself is a run that never stops being created, and
 * the failure without a limit is not a slow pipeline but an instance filling
 * its database. Cycles are caught by the trail as well, so this is the backstop
 * rather than the rule.
 */
export const MAX_CALL_DEPTH = 4

/**
 * Which repositories a workflow may call.
 *
 * The question the cross-repository half was waiting on, answered once here so
 * a cross-repository *trigger* can answer it the same way rather than inventing
 * a second rule.
 *
 * **The same owner, by default.** An organization calling its own shared
 * workflow is the case people actually have, and it needs no configuration to
 * be safe: a repository can already be read by anybody who can read the
 * organization. Calling *any* repository on the instance is a different
 * proposition - a private repository's workflow is not public because its
 * jobs would run somewhere else - so it is opt-in per instance.
 */
export type CallScope = 'same-owner' | 'instance'

export function callScope(setting: unknown): CallScope {
  return String(setting ?? '').trim() === 'instance' ? 'instance' : 'same-owner'
}

/**
 * Whether the caller may call the target, and why not when it may not.
 *
 * Pure, because it is the boundary: being wrong here runs one repository's
 * pipeline against another repository's code, and the answer has to be
 * checkable without a database.
 */
export function mayCall(input: {
  caller: { ownerType: string, ownerId: number }
  target: { ownerType: string, ownerId: number, visibility: string }
  scope: CallScope
}): { ok: boolean, reason: string } {
  const sameOwner = input.caller.ownerType === input.target.ownerType
    && Number(input.caller.ownerId) === Number(input.target.ownerId)

  if (sameOwner)
    return { ok: true, reason: '' }

  if (input.scope !== 'instance') {
    return {
      ok: false,
      reason: 'that workflow belongs to another owner, and this instance only calls within an owner. '
        + 'An administrator can widen it with the `workflow_call_scope` setting.',
    }
  }

  /*
   * Even with the instance-wide scope, a private repository's workflow is not
   * callable by strangers: its jobs would run against a definition nobody
   * outside can read, and "I cannot see the file that ran" is the shape of a
   * supply-chain problem rather than a convenience.
   */
  if (String(input.target.visibility) === 'private') {
    return {
      ok: false,
      reason: 'that workflow is in a private repository belonging to another owner, which is never callable.',
    }
  }

  return { ok: true, reason: '' }
}

/**
 * Resolve a `uses:` to a workflow version.
 *
 * `./.github/workflows/build.yml` for a local call, and
 * `owner/repository/.github/workflows/build.yml@ref` for another repository's -
 * which needed the policy above before it could be answered at all.
 */
export async function resolveCall(
  repositoryId: number,
  uses: string,
  suppliedInputs: Record<string, unknown>,
  options: { scope?: CallScope } = {},
): Promise<CallResolution> {
  const reference = String(uses ?? '').trim()

  if (!reference)
    return { ok: false, target: null, inputs: {}, error: 'this job has no `uses:`' }

  const remote = reference.startsWith('./') ? null : parseRemoteCall(reference)

  if (!reference.startsWith('./') && !remote) {
    return {
      ok: false,
      target: null,
      inputs: {},
      error: `\`${reference}\` is not a workflow reference: use \`./path\` or \`owner/repository/path@ref\``,
    }
  }

  const path = remote ? remote.path : (reference.slice(2).split('@')[0] ?? '')
  let targetRepositoryId = repositoryId

  if (remote) {
    const resolved = await resolveRemoteRepository(repositoryId, remote, options.scope ?? 'same-owner')

    if (!resolved.ok)
      return { ok: false, target: null, inputs: {}, error: resolved.error }

    targetRepositoryId = resolved.repositoryId
  }

  const workflow = await db
    .selectFrom('workflows')
    .select(['id', 'path', 'state'])
    .where('repository_id', '=', targetRepositoryId)
    .where('path', '=', path)
    .executeTakeFirst()

  if (!workflow)
    return { ok: false, target: null, inputs: {}, error: `no workflow is registered at \`${path}\`` }

  if (String(workflow.state) !== 'active')
    return { ok: false, target: null, inputs: {}, error: `the workflow at \`${path}\` is ${workflow.state}` }

  const version = await db
    .selectFrom('workflow_versions')
    .select(['id', 'reusable', 'call_inputs'])
    .where('workflow_id', '=', Number(workflow.id))
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()

  if (!version)
    return { ok: false, target: null, inputs: {}, error: `the workflow at \`${path}\` has no readable version` }

  /*
   * A workflow that did not say `workflow_call` cannot be called, even though
   * its jobs would copy in perfectly well. Calling one would run a pipeline its
   * author never offered as an interface, and the first time that matters is
   * the day somebody's `deploy.yml` is called by a workflow they have not read.
   */
  if (!isTrue(version.reusable))
    return { ok: false, target: null, inputs: {}, error: `the workflow at \`${path}\` does not accept \`workflow_call\`` }

  const declared = parseDeclared(version.call_inputs)
  const checked = checkInputs(declared, suppliedInputs)

  if (!checked.ok) {
    return {
      ok: false,
      target: null,
      inputs: {},
      error: `the inputs passed to \`${path}\` do not match what it declares: ${checked.errors.join('; ')}`,
    }
  }

  return {
    ok: true,
    target: { versionId: Number(version.id), path: String(workflow.path) },
    inputs: checked.values,
    error: null,
  }
}

/** `owner/repository/.github/workflows/build.yml@ref`, split. */
export function parseRemoteCall(reference: string): { owner: string, repository: string, path: string, ref: string } | null {
  const [withoutRef, ref = ''] = String(reference ?? '').split('@')
  const parts = String(withoutRef).split('/').filter(Boolean)

  // Owner, repository, and at least one path segment. Anything shorter is a
  // local path somebody forgot to write `./` in front of.
  if (parts.length < 3)
    return null

  return {
    owner: parts[0]!,
    repository: parts[1]!,
    path: parts.slice(2).join('/'),
    ref: ref.trim(),
  }
}

/** The called repository, once the policy has allowed it. */
async function resolveRemoteRepository(
  callerId: number,
  remote: { owner: string, repository: string },
  scope: CallScope,
): Promise<{ ok: true, repositoryId: number } | { ok: false, error: string }> {
  const caller = await db
    .selectFrom('repositories')
    .select(['owner_type', 'owner_id'])
    .where('id', '=', callerId)
    .executeTakeFirst()
    .catch(() => null)

  if (!caller)
    return { ok: false, error: 'the calling repository is gone' }

  const owner = await db
    .selectFrom('users')
    .select(['id'])
    .where('handle', '=', remote.owner)
    .executeTakeFirst()
    .catch(() => null)

  const organization: any = owner
    ? null
    : await db
        .selectFrom('organizations')
        .select(['id'])
        .where('handle', '=', remote.owner)
        .executeTakeFirst()
        .catch(() => null)

  if (!owner && !organization)
    return { ok: false, error: `there is no owner called \`${remote.owner}\` on this instance` }

  const target = await db
    .selectFrom('repositories')
    .select(['id', 'owner_type', 'owner_id', 'visibility'])
    .where('owner_type', '=', owner ? 'user' : 'organization')
    .where('owner_id', '=', Number(owner?.id ?? organization?.id))
    .where('name', '=', remote.repository)
    .executeTakeFirst()
    .catch(() => null)

  if (!target)
    return { ok: false, error: `there is no repository called \`${remote.owner}/${remote.repository}\` here` }

  const allowed = mayCall({
    caller: { ownerType: String(caller.owner_type), ownerId: Number(caller.owner_id) },
    target: { ownerType: String(target.owner_type), ownerId: Number(target.owner_id), visibility: String(target.visibility) },
    scope,
  })

  if (!allowed.ok)
    return { ok: false, error: allowed.reason }

  return { ok: true, repositoryId: Number(target.id) }
}

/** The inputs a called workflow declares, or none when it stored nothing readable. */
function parseDeclared(stored: unknown): any[] {
  const text = String(stored ?? '').trim()

  if (!text)
    return []

  try {
    const parsed = JSON.parse(text)

    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

/**
 * What a called workflow may read from the caller's secrets.
 *
 * Recorded, not resolved. `inherit` means "everything the caller had", a
 * mapping means "these, renamed", and both are answers the execution plane
 * needs *after* the fork check - a fork's pull request gets no secrets at all,
 * whatever any `secrets:` line says.
 */
export function secretsPolicy(stored: unknown): { inherit: boolean, named: string[] } {
  const value = typeof stored === 'string' ? tryParse(stored) : stored

  if (typeof value === 'string')
    return { inherit: value.trim().toLowerCase() === 'inherit', named: [] }

  if (value && typeof value === 'object' && !Array.isArray(value))
    return { inherit: false, named: Object.keys(value as Record<string, unknown>) }

  return { inherit: false, named: [] }
}

function tryParse(text: string): unknown {
  const trimmed = text.trim()

  if (!trimmed)
    return null

  try {
    return JSON.parse(trimmed)
  }
  catch {
    // A bare `inherit` was stored as a JSON string; anything else unreadable is
    // no policy at all, which grants nothing.
    return trimmed
  }
}
