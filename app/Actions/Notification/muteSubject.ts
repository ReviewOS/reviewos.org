import { db } from '@stacksjs/database'
import type { Scope } from './unsubscribe'

/** Persist a subject mute and report whether a new row was created. */
export async function setSubjectMute(userId: number, scope: Scope, expiresAt: string | null): Promise<boolean> {
  const existing = await db.selectFrom('notification_mutes').select(['id'])
    .where('user_id', '=', userId).where('subject_type', '=', scope.type).where('subject_id', '=', scope.id).executeTakeFirst()
  if (existing) {
    await db.updateTable('notification_mutes').set({ expires_at: expiresAt }).where('id', '=', Number(existing.id)).execute()
    return false
  }
  else {
    await db.insertInto('notification_mutes').values({ user_id: userId, subject_type: scope.type, subject_id: scope.id, expires_at: expiresAt }).execute()
    return true
  }
}
