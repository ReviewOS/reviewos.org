import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from './authorize'
import { decideRelease, DRAFT, isUsableTagName, looksLikePrerelease, PUBLISHED } from './releases'
import { dbTimestamp } from '../Support/sql'

/**
 * Publish, edit or delete a release.
 *
 * One endpoint with the operation in the body, for the reason the label and
 * milestone endpoints are one each: all three share the rule that decides
 * whether a tag already has a release, and splitting them into three routes is
 * how that rule ends up implemented three times and disagreeing twice.
 *
 * **The tag has to exist.** A release is a tag plus notes, so publishing one
 * for a tag nobody pushed produces a release that cannot be downloaded and a
 * version number that names nothing. Creating the tag here instead was the
 * alternative, and it is worse: it means this endpoint writes to the
 * repository, so a release becomes something that can change what a clone
 * contains.
 */
export default new Action({
  name: 'ManageRelease',
  description: 'Publish, edit or delete a release',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    body: { rule: schema.string() },
    is_draft: { rule: schema.string() },
    is_prerelease: { rule: schema.string() },
    name: { rule: schema.string() },
    operation: { rule: schema.string() },
    tag_name: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const operation = String(request.get('operation') ?? 'create').trim().toLowerCase()

    // Publishing is a write, and so is editing the notes: `repository:settings`
    // rather than `repository:push`, because a release is an announcement about
    // the project rather than a change to its code.
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const tag = String(request.get('tag_name') ?? '').trim()

    if (!isUsableTagName(tag))
      return response.json({ error: 'That tag name cannot be used' }, 422)

    const existing = await db
      .selectFrom('releases')
      .selectAll()
      .where('repository_id', '=', Number(repository.id))
      .where('tag_name', '=', tag)
      .executeTakeFirst()

    if (operation === 'delete') {
      if (!existing)
        return response.json({ error: 'No release for that tag' }, 404)

      // The assets go with it. They are files that only make sense as part of
      // this release, and leaving them would be rows pointing at a release
      // that is not there.
      await db.deleteFrom('release_assets').where('release_id', '=', Number(existing.id)).execute()
      await db.deleteFrom('releases').where('id', '=', Number(existing.id)).execute()

      // The tag is left alone, deliberately. Deleting it would rewrite what a
      // clone contains as a side effect of removing some notes.
      return response.json({ deleted: tag, tag_kept: true })
    }

    if (operation !== 'create' && operation !== 'update')
      return response.json({ error: 'An operation is create, update or delete' }, 422)

    if (operation === 'create' && existing)
      return response.json({ error: 'That tag already has a release' }, 409)

    if (operation === 'update' && !existing)
      return response.json({ error: 'No release for that tag' }, 404)

    const owner = String(request.get('owner') ?? '').trim().toLowerCase()
    const path = repositoryPath(owner, repository.name)

    if (!path.ok)
      return response.json({ error: 'Not found' }, 404)

    // Resolved now and stored, because a tag can be moved. This is what says
    // which commit was actually released; a release whose notes describe a
    // commit nobody can name again is worth less than no release.
    const resolved = await runGit(path.path!, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])

    if (!resolved.ok && operation === 'create')
      return response.json({ error: `This repository has no tag called ${tag}` }, 422)

    const isDraft = readFlag(request.get('is_draft'))
    const prerelease = request.get('is_prerelease')

    const decision = decideRelease({
      tag_name: tag,
      name: request.get('name'),
      body: request.get('body'),
      is_draft: isDraft,
      // Offered as a default rather than as a rule: the flag decides, and the
      // tag's own suffix is a good guess at what somebody meant by `-rc.1`.
      is_prerelease: prerelease === undefined ? looksLikePrerelease(tag) : readFlag(prerelease),
    }, dbTimestamp(), existing ? { status: String(existing.status ?? DRAFT), published_at: existing.published_at ?? null } : undefined)

    if (!decision.ok)
      return response.json({ error: decision.error }, decision.status)

    if (existing) {
      await db.updateTable('releases').set(decision.changes).where('id', '=', Number(existing.id)).execute()

      return response.json({ id: Number(existing.id), tag_name: tag, ...decision.changes })
    }

    const created = await db
      .insertInto('releases')
      .values({
        repository_id: Number(repository.id),
        user_id: user?.id ?? null,
        target_sha: resolved.stdout.trim(),
        // A release with no headline shows its tag, which is what people call
        // it anyway.
        name: String(decision.changes.name ?? '') || tag,
        notes: String(decision.changes.notes ?? ''),
        // The framework's own columns on this table, filled in rather than left
        // null: a release's version *is* its tag, and `author` is what the
        // dashboard shows where it has no user to join to.
        version: tag.slice(0, 50),
        author: user?.handle ?? '',
        status: PUBLISHED,
        downloads: 0,
        ...decision.changes,
      })
      .returning(['id'])
      .executeTakeFirst()

    // A draft is not published. Announcing one would tell everybody watching
    // about a release that is deliberately unannounced, which is the entire
    // thing a draft is keeping.
    // `user` is nullable on this path. A release with no actor has nobody to
    // name in the sentence and nobody to leave out of the audience, so it is
    // not announced rather than announced by "somebody".
    if (!isDraft && user) {
      const { notify } = await import('../../Notifications/emit')
      await notify('release:published', {
        actorId: user.id,
        actorHandle: user.handle,
        repositoryId: repository.id,
        owner: String(request.get('owner') ?? '').trim().toLowerCase(),
        repository: repository.name,
        // A release belongs to the repository, so its audience is the watchers
        // rather than a thread nobody has been subscribed to.
        subjectType: 'repository',
        subjectId: repository.id,
        detail: tag,
        subscribeActor: false,
      })
    }

    return response.json({
      id: Number(created?.id),
      tag_name: tag,
      target_sha: resolved.stdout.trim(),
      ...decision.changes,
    }, 201)
  },
})

/** A checkbox, as a form sends it. Anything unrecognised is false. */
function readFlag(value: unknown): boolean {
  const text = String(value ?? '').toLowerCase()

  return text === 'true' || text === '1' || text === 'on' || text === 'yes'
}
