import { db } from '@stacksjs/database'
import type { AuditPayload } from '../../Audit/events'
import { auditEvent } from '../../Audit/events'
import { moveRepository } from '../Git/move'
import type { TransferTarget } from './settings'
import { decideTransfer } from './settings'

/** Shared by an authorized transfer request and administrator account reconciliation. */
export async function transferRepository(repositoryId: number, target: TransferTarget, actor: Pick<AuditPayload, 'actorId' | 'externalActor' | 'ip' | 'userAgent' | 'tokenId'>) {
  const repository = await db.selectFrom('repositories').selectAll().where('id', '=', repositoryId).executeTakeFirst()
  if (!repository)
    return { ok: false as const, error: 'No such repository', status: 404 }
  const source = await db.selectFrom(repository.owner_type === 'user' ? 'users' : 'organizations')
    .select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()
  if (!source)
    return { ok: false as const, error: 'No such owner', status: 404 }
  const taken = await db.selectFrom('repositories').select(['id'])
    .where('owner_type', '=', target.kind).where('owner_id', '=', target.id)
    .where('name', '=', repository.name).executeTakeFirst()
  const decision = decideTransfer(repository as any, target, Boolean(taken))
  if (!decision.ok) return decision

  const fromHandle = String(source.handle)
  let diskPath: string
  try {
    diskPath = await moveRepository(fromHandle, target.handle, String(repository.name))
  }
  catch (error) {
    return { ok: false as const, error: `Could not move the repository: ${error}`, status: 500 }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.updateTable('repositories').set({ owner_type: target.kind, owner_id: target.id, disk_path: diskPath })
        .where('id', '=', repositoryId).execute()
      await tx.deleteFrom('repo_collaborators').where('repository_id', '=', repositoryId).execute()
    })
  }
  catch (error) {
    await moveRepository(target.handle, fromHandle, String(repository.name))
    throw error
  }

  await auditEvent('repository:transferred', {
    ...actor, subject: { type: 'repository', id: repositoryId }, repositoryId,
    organizationId: repository.owner_type === 'organization' ? Number(repository.owner_id) : null,
    detail: {
      name: repository.name,
      from: { kind: repository.owner_type, id: repository.owner_id, handle: fromHandle },
      to: target,
    },
  })
  return { ok: true as const, id: repositoryId, owner: target.handle, name: String(repository.name), moved_from: `${fromHandle}/${repository.name}` }
}
