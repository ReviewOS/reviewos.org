/**
 * What can be changed about a repository, and what changing it costs.
 *
 * Every one of these is a decision rather than a field assignment, and the
 * decisions have consequences outside this row - a rename moves a directory and
 * breaks every clone URL somebody has written down, a visibility change can
 * expose work, a transfer moves the repository into a permission structure it
 * has never been under. So the rules are here, pure, and the actions do the
 * database and disk work against answers they did not have to work out.
 */

import { isSafeSegment } from '../Git/storage'

/** Fields a settings change may touch. Absent means "leave it alone". */
export interface SettingsPatch {
  name?: string
  description?: string | null
  visibility?: string
  default_branch?: string
  is_archived?: boolean
  is_template?: boolean
}

export type SettingsRejection =
  | { ok: false, error: string, status: number }

export type SettingsDecision =
  | { ok: true, changes: Record<string, unknown>, renamedFrom?: string }
  | SettingsRejection

export const VISIBILITIES = ['public', 'private', 'internal'] as const

/**
 * Whether a repository name can be used.
 *
 * The same rule the path builder enforces, asked here so the caller gets a
 * sentence rather than a rejected path. A name is a directory on disk, so the
 * two can never disagree: anything this accepts and the path builder refuses
 * would be a row with no repository behind it.
 */
export function isUsableName(name: string): boolean {
  return isSafeSegment(name)
}

/**
 * Read a settings change.
 *
 * Absent is not the same as empty. `description: ''` clears the description on
 * purpose; sending no description at all leaves it alone, and a form that
 * always submits every field would otherwise wipe whatever it did not show.
 *
 * Archiving is the one that carries a rule rather than a validation: an
 * archived repository is readable and frozen, so *un*archiving is allowed and
 * everything else about an archived repository is not - which the caller
 * enforces, because it needs the current state to do it.
 */
export function decideSettings(
  current: { name: string, is_archived?: boolean },
  patch: SettingsPatch,
): SettingsDecision {
  const changes: Record<string, unknown> = {}
  let renamedFrom: string | undefined

  if (patch.name !== undefined) {
    const name = String(patch.name).trim()

    if (!isUsableName(name))
      return { ok: false, error: 'That repository name cannot be used', status: 422 }

    if (name !== current.name) {
      changes.name = name
      renamedFrom = current.name
    }
  }

  if (patch.description !== undefined) {
    const description = patch.description === null ? null : String(patch.description).trim()

    if (description !== null && description.length > 500)
      return { ok: false, error: 'That description is too long', status: 422 }

    changes.description = description || null
  }

  if (patch.visibility !== undefined) {
    const visibility = String(patch.visibility).trim().toLowerCase()

    if (!(VISIBILITIES as readonly string[]).includes(visibility))
      return { ok: false, error: 'No such visibility', status: 422 }

    changes.visibility = visibility
  }

  if (patch.default_branch !== undefined) {
    const branch = String(patch.default_branch).trim()

    // A branch name, not a ref: `refs/heads/main` here would produce
    // `refs/heads/refs/heads/main` the moment anything prefixed it.
    if (!branch || branch.startsWith('refs/') || !isSafeSegment(branch.split('/')[0] ?? ''))
      return { ok: false, error: 'That branch name cannot be used', status: 422 }

    changes.default_branch = branch
  }

  if (patch.is_archived !== undefined)
    changes.is_archived = Boolean(patch.is_archived)

  if (patch.is_template !== undefined)
    changes.is_template = Boolean(patch.is_template)

  if (Object.keys(changes).length === 0)
    return { ok: false, error: 'Nothing to change', status: 422 }

  return { ok: true, changes, renamedFrom }
}

/**
 * Whether a change is allowed while the repository is archived.
 *
 * Archived means readable and frozen. The one change that must always be
 * allowed is the one that unfreezes it - otherwise archiving is irreversible,
 * which is not what anybody means by archiving.
 */
export function allowedWhileArchived(changes: Record<string, unknown>): boolean {
  return Object.keys(changes).every(key => key === 'is_archived') && changes.is_archived === false
}

/**
 * Where a deleted repository goes.
 *
 * Moved aside with a timestamp rather than unlinked, because the difference
 * between "deleted the wrong repository" and "deleted the wrong repository and
 * it is gone" is the difference between a bad afternoon and an unrecoverable
 * one. A retention sweep removes them later; until then the bytes are still
 * there and a mistake is a `mv` away from being undone.
 *
 * The timestamp is in the name rather than in a table so that somebody looking
 * at the directory can see what happened without the application running -
 * which is exactly the situation somebody is in when they need this.
 */
export const DELETED_DIRECTORY = 'storage/repos-deleted'

export function retiredPath(owner: string, name: string, atMs: number): string | null {
  if (!isSafeSegment(owner) || !isSafeSegment(name))
    return null

  // `2026-08-05T19-30-00-000Z`: sortable, and with the colons a filesystem
  // dislikes replaced.
  const stamp = new Date(atMs).toISOString().replaceAll(':', '-').replace('.', '-')

  return `${DELETED_DIRECTORY}/${owner}/${name}.${stamp}.git`
}

export interface TransferTarget {
  kind: 'user' | 'organization'
  id: number
  handle: string
}

export type TransferDecision =
  | { ok: true, diskPath: string }
  | SettingsRejection

/**
 * Whether a repository may move to a new owner, and where it lands.
 *
 * A transfer is the most destructive thing on this page that is not a delete.
 * Every clone URL changes, every collaborator grant from the old owner stops
 * applying, and the repository lands under whatever permission structure the
 * new owner has - so it is refused rather than reconciled whenever the answer
 * is not obvious:
 *
 * - **Onto itself.** Nothing to do, and the disk move would collide with the
 *   directory it is moving out of.
 * - **Onto a name already taken there.** There is no correct silent answer, and
 *   the correct loud one is to tell somebody to pick a name.
 * - **An archived repository.** Frozen is frozen.
 */
export function decideTransfer(
  current: { name: string, owner_type: string, owner_id: number, is_archived?: boolean },
  target: TransferTarget,
  nameTakenAtTarget: boolean,
): TransferDecision {
  if (current.is_archived)
    return { ok: false, error: 'An archived repository cannot be transferred', status: 409 }

  if (current.owner_type === target.kind && Number(current.owner_id) === Number(target.id))
    return { ok: false, error: 'That is already the owner', status: 422 }

  if (nameTakenAtTarget)
    return { ok: false, error: `${target.handle} already has a repository called ${current.name}`, status: 409 }

  if (!isSafeSegment(target.handle) || !isSafeSegment(current.name))
    return { ok: false, error: 'That owner or repository name cannot be used', status: 422 }

  return { ok: true, diskPath: `${target.handle}/${current.name}.git` }
}

/**
 * The name a fork takes under its new owner.
 *
 * The source name, unless it is taken - in which case a suffix, because
 * refusing to fork on a name collision is refusing the single most common fork
 * there is: the second fork of a popular repository into an account that
 * already has one.
 */
export function forkName(sourceName: string, taken: readonly string[]): string | null {
  if (!isSafeSegment(sourceName))
    return null

  const used = new Set(taken.map(name => name.toLowerCase()))
  if (!used.has(sourceName.toLowerCase()))
    return sourceName

  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidate = `${sourceName}-${suffix}`
    if (!used.has(candidate.toLowerCase()) && isSafeSegment(candidate))
      return candidate
  }

  return null
}
