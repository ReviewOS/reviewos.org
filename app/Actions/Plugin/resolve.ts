/**
 * Reading a plugin out of git, at dispatch, before anything runs.
 *
 * Everything here is plumbing against a bare repository on this instance - the
 * same way workflow files are read. Nothing is checked out, nothing is
 * executed: a hook is bytes on their way to a runner that will decide whether
 * it is allowed to run them.
 *
 * **Resolved to a commit, always.** A plugin referenced by tag is recorded as
 * the sha that tag pointed at when the run was created, so a tag moved
 * afterwards does not change what a re-run executes. This is the same promise
 * the workflow definition itself makes.
 */

import type { PluginManifest } from './manifest'
import type { PluginReference } from './reference'
import { db } from '@stacksjs/database'
import { resolveOwner } from '../Identity/lookup'
import { runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { HOOK_STAGES } from '../Runner/hooks'
import { parseManifest } from './manifest'

/** A plugin read at a commit: its manifest and the hook scripts it ships. */
export interface ResolvedPlugin {
  reference: PluginReference
  manifest: PluginManifest
  /** Which commit this is, so a re-run executes the same bytes. */
  sha: string
  /** What the ref turned out to be, which is what a pinning policy asks about. */
  refKind: 'commit' | 'tag' | 'branch'
  /** Stage to script source, only for stages the plugin actually ships. */
  hooks: Record<string, string>
}

/** Bigger than any hook script anybody writes by hand. */
export const MAX_HOOK_BYTES = 128 * 1024

/**
 * Where a plugin's files live inside its source.
 *
 * A vendored plugin sits at `.reviewos/plugins/<name>/`, so its manifest is at
 * `<that>/plugin.yml`; a plugin repository is the plugin, so its manifest is at
 * the root. One prefix covers both.
 */
function prefixOf(reference: PluginReference): string {
  return reference.kind === 'vendored' ? `${reference.source}/` : ''
}

export type Resolution = { ok: true, plugin: ResolvedPlugin } | { ok: false, reason: string }

/**
 * Resolve one reference.
 *
 * `gitDir` and `sha` are the *using* repository's, which is all a vendored
 * plugin needs. A repository plugin is looked up on this instance instead, and
 * has to be one the using owner may read.
 */
export async function resolvePlugin(input: {
  reference: PluginReference
  gitDir: string
  sha: string
  /** The owner of the repository doing the using, for the visibility rule. */
  ownerType: string
  ownerId: number
  /**
   * Whether an operator attached this rather than a workflow referencing it.
   *
   * The visibility rule below exists to stop a workflow reading a private
   * repository by naming it as a plugin. An operator attaching one to their own
   * pool is not that: it is the same act as putting a hook on the machine.
   */
  operatorAttached?: boolean
}): Promise<Resolution> {
  const { reference } = input

  const source = reference.kind === 'vendored'
    ? { gitDir: input.gitDir, sha: input.sha, refKind: 'commit' as const }
    : await pluginRepository(reference, input)

  if (!('gitDir' in source))
    return source

  const prefix = prefixOf(reference)
  const manifestSource = await show(source.gitDir, `${source.sha}:${prefix}plugin.yml`)

  if (manifestSource === null)
    return { ok: false, reason: `\`${reference.raw}\` has no plugin.yml at ${reference.kind === 'vendored' ? reference.source : source.sha.slice(0, 8)}` }

  const parsed = parseManifest(manifestSource, reference.name)

  if ('error' in parsed)
    return { ok: false, reason: `\`${reference.raw}\`: ${parsed.error}` }

  const hooks: Record<string, string> = {}

  /*
   * Only the stages the manifest declares are read.
   *
   * A file in `hooks/` that the manifest does not name is not run, which makes
   * the manifest the description of the plugin rather than a summary of it -
   * and means a plugin cannot acquire a `pre-bootstrap` hook by having a file
   * with that name appear in it.
   */
  for (const stage of parsed.manifest.hooks) {
    if (!(HOOK_STAGES as readonly string[]).includes(stage))
      continue

    const script = await show(source.gitDir, `${source.sha}:${prefix}hooks/${stage}`)

    if (script === null)
      return { ok: false, reason: `\`${reference.raw}\` declares a ${stage} hook and does not ship one` }

    if (script.length > MAX_HOOK_BYTES)
      return { ok: false, reason: `\`${reference.raw}\`'s ${stage} hook is larger than ${MAX_HOOK_BYTES} bytes` }

    hooks[stage] = script
  }

  return {
    ok: true,
    plugin: { reference, manifest: parsed.manifest, sha: source.sha, refKind: source.refKind, hooks },
  }
}

/** The bare repository a `owner/name#ref` plugin lives in, and the commit it names. */
async function pluginRepository(
  reference: PluginReference,
  input: { ownerType: string, ownerId: number, operatorAttached?: boolean },
): Promise<{ gitDir: string, sha: string, refKind: 'commit' | 'tag' | 'branch' } | { ok: false, reason: string }> {
  const [ownerHandle = '', name = ''] = reference.source.split('/')

  // One resolver for both namespaces, the same one the rest of the codebase
  // uses: a handle is a user or an organization and nothing here should have an
  // opinion about which.
  const resolvedOwner = await resolveOwner(ownerHandle)

  if (!resolvedOwner)
    return { ok: false, reason: `\`${reference.raw}\`: there is no \`${ownerHandle}\` on this instance` }

  const ownerType = resolvedOwner.kind
  const ownerId = resolvedOwner.id

  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'visibility'])
    .where('owner_type', '=', ownerType)
    .where('owner_id', '=', ownerId)
    .where('name', '=', name)
    .executeTakeFirst()

  if (!repository)
    return { ok: false, reason: `\`${reference.raw}\`: there is no such repository on this instance` }

  /*
   * A private plugin is only usable by its own owner.
   *
   * Not a full permission check - there is no user at dispatch, and a run is
   * not a person - so the rule is the one that cannot leak: public, or the same
   * owner. Anything more permissive would let a workflow read a private
   * repository's contents by referencing it as a plugin and printing what
   * arrives.
   */
  const sameOwner = String(input.ownerType) === ownerType && Number(input.ownerId) === ownerId

  if (String(repository.visibility) !== 'public' && !sameOwner && input.operatorAttached !== true)
    return { ok: false, reason: `\`${reference.raw}\`: that plugin is private to another owner` }

  const resolved = repositoryPath(ownerHandle, name)

  if (!resolved.path)
    return { ok: false, reason: `\`${reference.raw}\`: that repository has no directory on this instance` }

  return commitOf(resolved.path, reference)
}

/** Which commit a reference names, and whether the ref was a tag or a branch. */
async function commitOf(
  gitDir: string,
  reference: PluginReference,
): Promise<{ gitDir: string, sha: string, refKind: 'commit' | 'tag' | 'branch' } | { ok: false, reason: string }> {
  if (reference.pin === 'commit') {
    const exists = await runGit(gitDir, ['cat-file', '-e', `${reference.ref}^{commit}`]).catch(() => null)

    return exists?.code === 0
      ? { gitDir, sha: String(reference.ref), refKind: 'commit' }
      : { ok: false, reason: `\`${reference.raw}\`: that commit is not in that repository` }
  }

  /*
   * Tags before branches, and both asked for explicitly rather than letting
   * `rev-parse` guess. The answer to "is this pinned" depends on which one it
   * was, and a resolution that cannot tell them apart cannot enforce a pinning
   * policy.
   */
  const ref = reference.ref ?? 'HEAD'
  const candidates: Array<{ revision: string, refKind: 'commit' | 'tag' | 'branch' }> = reference.ref
    ? [
        { revision: `refs/tags/${ref}^{commit}`, refKind: 'tag' },
        { revision: `refs/heads/${ref}`, refKind: 'branch' },
      ]
    : [{ revision: 'HEAD', refKind: 'branch' }]

  for (const candidate of candidates) {
    const result = await runGit(gitDir, ['rev-parse', '--verify', candidate.revision]).catch(() => null)

    if (result?.code === 0 && result.stdout.trim())
      return { gitDir, sha: result.stdout.trim(), refKind: candidate.refKind }
  }

  return { ok: false, reason: `\`${reference.raw}\`: no tag or branch called \`${ref}\`` }
}

/** One file at one commit, or null when it is not there. */
async function show(gitDir: string, revision: string): Promise<string | null> {
  const result = await runGit(gitDir, ['show', revision], { timeoutMs: 15_000 }).catch(() => null)

  return result?.code === 0 ? result.stdout : null
}
