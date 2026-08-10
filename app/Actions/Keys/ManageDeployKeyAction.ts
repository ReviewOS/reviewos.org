import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { authorizeRepository } from '../Repo/authorize'
import { readDeployKey } from './deploy'

/**
 * Add or remove a repository's deploy keys.
 *
 * Behind `repository:settings`, which is the same gate as renaming or deleting
 * it - and rightly: a deploy key is standing access to the repository, so
 * anybody who can grant one can already do worse.
 *
 * One endpoint with an `operation`, like the label and milestone sets, because
 * a browser form can only send GET or POST and every write here goes through
 * one.
 */
export default new Action({
  name: 'ManageDeployKey',
  description: 'Add or remove a deploy key on a repository',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context

    // The scope every audit row from this action carries. A deploy key belongs
    // to a repository, so its organization owner is exactly who should see one
    // being added to something they own.
    const scope = {
      repositoryId: Number(repository.id),
      organizationId: String(repository.owner_type) === 'organization' ? Number(repository.owner_id) : null,
    }
    const operation = String(request.get('operation') ?? 'create').trim()

    if (operation === 'delete') {
      const id = Number(request.get('id') ?? 0)
      if (!Number.isInteger(id) || id <= 0)
        return response.json({ error: 'Which key?' }, 422)

      // Read for the record. The delete below is still one statement scoped to
      // the repository, so the property this comment used to describe on its
      // own is intact - what this adds is a row that says which key, since
      // afterwards there is no fingerprint left to name.
      const key: any = await db
        .selectFrom('deploy_keys')
        .select(['id', 'title', 'fingerprint', 'can_write'])
        .where('id', '=', id)
        .where('repository_id', '=', Number(repository.id))
        .executeTakeFirst()

      // Scoped to the repository in the `where` rather than checked and then
      // deleted: one statement that can only match this repository's rows has
      // no window in between, and cannot be got wrong by a later edit.
      await db
        .deleteFrom('deploy_keys')
        .where('id', '=', id)
        .where('repository_id', '=', Number(repository.id))
        .execute()

      if (key) {
        await auditEvent('key:removed', {
          subject: { type: 'deploy_key', id },
          actorId: user?.id ?? null,
          ...await auditFrom(request),
          ...scope,
          detail: {
            kind: 'deploy',
            title: String(key.title ?? ''),
            fingerprint: String(key.fingerprint ?? ''),
            can_write: Boolean(key.can_write),
          },
        })
      }

      return response.json({ ok: true })
    }

    if (operation !== 'create')
      return response.json({ error: `Unknown operation: ${operation}` }, 422)

    const parsed = await readDeployKey(String(request.get('key') ?? ''))
    if (!parsed.ok)
      return response.json({ error: parsed.message }, parsed.status)

    // Off unless asked for. A key that can rewrite history from a build server
    // nobody is watching should have to be requested, not defaulted into.
    const canWrite = ['1', 'true', 'on', 'yes'].includes(String(request.get('can_write') ?? '').toLowerCase())
    const title = String(request.get('title') ?? '').trim() || parsed.comment || 'Deploy key'

    const created = await db
      .insertInto('deploy_keys')
      .values({
        repository_id: Number(repository.id),
        title,
        key_type: parsed.type,
        public_key: `${parsed.type} ${parsed.body}`,
        fingerprint: parsed.fingerprint,
        can_write: canWrite,
      })
      .returning(['id'])
      .executeTakeFirst()

    // `can_write` is the field worth reading twice in a log. A read-only deploy
    // key on a build server is ordinary; a writable one is a credential that
    // can rewrite history from a machine nobody is watching, and the difference
    // is one checkbox that nothing else records.
    await auditEvent('key:added', {
      subject: { type: 'deploy_key', id: Number(created?.id) },
      actorId: user?.id ?? null,
      ...await auditFrom(request),
      ...scope,
      detail: { kind: 'deploy', title, fingerprint: parsed.fingerprint, can_write: canWrite },
    })

    return response.json({ id: Number(created?.id), title, fingerprint: parsed.fingerprint, canWrite }, 201)
  },
})
