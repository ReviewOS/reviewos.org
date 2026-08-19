import { db } from '@stacksjs/database'
import { createCommit } from '../Git/write'
import { ensureLocal } from '../Git/storage'
import { runGit } from '../Git/git'
import { parseWorkflow } from './parse'
import { syncWorkflowFile } from './sync'

/**
 * Templates an owner publishes, and applying one to a repository.
 *
 * The governance side of reuse. A reusable workflow is called by a repository
 * that decided to call it; a template is what an organization puts in front of
 * every repository that has not decided anything yet - and new repositories are
 * where CI conventions are actually set, while "copy it from another
 * repository" is how they drift.
 *
 * **Validated when published.** A template that does not parse is refused where
 * somebody is looking at it, rather than failing on the first push in a
 * repository whose owner did not write it - by which point the person debugging
 * has no idea it came from a template at all.
 *
 * **Applying writes a real commit**, on a branch, through the same plumbing a
 * web edit would use. Offering the YAML for somebody to paste would make this a
 * documentation feature; a commit is a thing that either happened or did not.
 */

export interface TemplateInput {
  ownerType: string
  ownerId: number
  slug: string
  name: string
  description: string
  path: string
  source: string
  userId?: number | null
}

export type PublishOutcome =
  | { ok: true, id: number }
  | { ok: false, reason: string, problems: string[] }

/** Publish one, or refuse it with the parser's own complaints. */
export async function publishTemplate(input: TemplateInput): Promise<PublishOutcome> {
  const slug = String(input.slug ?? '').trim().toLowerCase()

  if (!/^[a-z0-9][a-z0-9-]{0,118}$/.test(slug))
    return { ok: false, reason: 'A template needs a slug: lowercase letters, digits and hyphens.', problems: [] }

  const parsed = parseWorkflow(input.source, input.path || 'template.yml')

  if (!parsed.ok) {
    /*
     * The whole point of validating here. A template is copied into
     * repositories by people who did not write it, and one that fails on their
     * first push is a support ticket from somebody with no way to know where
     * the file came from.
     */
    return {
      ok: false,
      reason: 'This template is not a workflow this instance can run.',
      problems: parsed.errors.map(one => `line ${one.line}: ${one.message}`),
    }
  }

  const existing = await db
    .selectFrom('workflow_templates')
    .select(['id'])
    .where('owner_type', '=', input.ownerType)
    .where('owner_id', '=', input.ownerId)
    .where('slug', '=', slug)
    .executeTakeFirst()

  const values = {
    owner_type: input.ownerType,
    owner_id: input.ownerId,
    slug,
    name: String(input.name || slug).slice(0, 200),
    description: String(input.description ?? '').slice(0, 1000),
    path: String(input.path || '.github/workflows/ci.yml').slice(0, 500),
    source: input.source,
    created_by_id: input.userId ?? null,
  }

  if (existing) {
    await db.updateTable('workflow_templates').set(values as any).where('id', '=', Number(existing.id)).execute()

    return { ok: true, id: Number(existing.id) }
  }

  const row = await db.insertInto('workflow_templates').values(values as any).returning(['id']).executeTakeFirst()

  return { ok: true, id: Number(row?.id ?? 0) }
}

export type ApplyOutcome =
  | { ok: true, sha: string, path: string, branch: string, workflowId: number | null }
  | { ok: false, reason: string, status: number }

/**
 * Apply a template to a repository: one commit, on a branch.
 *
 * **It refuses to overwrite.** A repository that already has a file at that
 * path has somebody's workflow in it, and a template that quietly replaced it
 * would be governance in the worst sense - the organization's convention
 * silently deleting the exception somebody made on purpose. `overwrite` is
 * there for when that is meant.
 */
export async function applyTemplate(input: {
  repositoryId: number
  ownerHandle: string
  repositoryName: string
  templateId: number
  branch?: string | null
  overwrite?: boolean
  author: { name: string, email: string }
}): Promise<ApplyOutcome> {
  const template = await db
    .selectFrom('workflow_templates')
    .selectAll()
    .where('id', '=', input.templateId)
    .executeTakeFirst()

  if (!template)
    return { ok: false, reason: 'No such template', status: 404 }

  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'owner_type', 'owner_id', 'default_branch'])
    .where('id', '=', input.repositoryId)
    .executeTakeFirst()

  if (!repository)
    return { ok: false, reason: 'No such repository', status: 404 }

  /*
   * An owner's template goes into that owner's repositories.
   *
   * Not a permission check - the caller's access is checked at the endpoint -
   * but a scoping one: a template is a statement about how *this* organization
   * builds things, and applying one across owners would make it a shared
   * library with none of the versioning a library needs.
   */
  if (String(repository.owner_type) !== String(template.owner_type) || Number(repository.owner_id) !== Number(template.owner_id))
    return { ok: false, reason: 'That template belongs to a different owner', status: 403 }

  /*
   * `ensureLocal`, because this is about to write a commit: a repository this
   * node has not materialized is a cache miss rather than a missing
   * repository, and writing into a directory that was never populated would
   * produce a commit with no history behind it.
   */
  const resolved = await ensureLocal(input.ownerHandle, input.repositoryName)

  if (!resolved.ok || !resolved.path)
    return { ok: false, reason: 'That repository has no directory on this instance', status: 404 }

  const branch = String(input.branch ?? repository.default_branch ?? 'main')
  const path = String(template.path)
  /*
   * The branch's tip, or null when the branch does not exist yet - which is an
   * ordinary case here: applying a template to a repository nobody has pushed
   * to is exactly the moment a starting point is worth having.
   */
  const rev = await runGit(resolved.path, ['rev-parse', '--verify', `refs/heads/${branch}`]).catch(() => null)
  const tip = rev?.code === 0 ? rev.stdout.trim() : null

  if (tip && !input.overwrite) {
    const existing = await runGit(resolved.path, ['cat-file', '-e', `${tip}:${path}`]).catch(() => null)

    if (existing?.code === 0) {
      return {
        ok: false,
        reason: `\`${path}\` already exists on \`${branch}\`. Applying would replace somebody's workflow, so pass \`overwrite\` if that is meant.`,
        status: 409,
      }
    }
  }

  const commit = await createCommit(resolved.path, {
    branch,
    parentSha: tip,
    expectedBranchSha: tip,
    message: `Add ${template.name} from the ${input.ownerHandle} workflow template`,
    author: input.author,
    files: { [path]: String(template.source) },
  })

  if (!commit.ok)
    return { ok: false, reason: commit.error, status: 409 }

  /*
   * Registered here rather than left to a push hook.
   *
   * The hook runs for a push over the wire; this commit was written by the
   * instance itself, so nothing would fire - and a template that lands as a
   * file nothing has read is a workflow that does not exist until somebody
   * happens to push again.
   */
  const synced = await syncWorkflowFile({
    repositoryId: input.repositoryId,
    ownerType: String(repository.owner_type) === 'organization' ? 'organization' : 'user',
    ownerId: Number(repository.owner_id),
    path,
    source: String(template.source),
    sha: commit.sha,
  }).catch((error) => {
    /*
     * Registration failing is not the commit failing - the file is on the
     * branch either way - so this reports rather than throws. Said out loud
     * because a template that lands and is never registered is the confusing
     * half-success this whole function exists to avoid.
     */
    console.error('[templates] applied but could not register the workflow:', error)

    return null
  })

  return {
    ok: true,
    sha: commit.sha,
    path,
    branch,
    workflowId: synced?.workflowId ?? null,
  }
}

/** An owner's templates, newest first. */
export async function templatesFor(ownerType: string, ownerId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_templates')
    .select(['id', 'slug', 'name', 'description', 'path', 'created_at'])
    .where('owner_type', '=', ownerType)
    .where('owner_id', '=', ownerId)
    .orderBy('id', 'desc')
    .limit(200)
    .execute()
    .catch(() => [])
}
