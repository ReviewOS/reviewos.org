import { db } from '@stacksjs/database'
import { transaction } from '@stacksjs/orm'
import { dbTimestamp } from '../Support/sql'

export interface EmailAccount {
  id: number
  handle: string
  email: string
  primaryEmail: string
}

export function normalizeEmail(value: string): string {
  return String(value).trim().toLowerCase()
}

/** Two bulk queries cover primary addresses and verified aliases. */
export async function accountsForEmails(emails?: readonly string[]): Promise<EmailAccount[]> {
  if (emails && emails.length === 0)
    return []

  let primary = db.selectFrom('users').select(['id', 'handle', 'email'])
  let aliases = db.selectFrom('user_emails')
    .innerJoin('users', 'users.id', '=', 'user_emails.user_id')
    .select(['users.id as id', 'users.handle as handle', 'users.email as primary_email', 'user_emails.email as email'])
    .whereNotNull('user_emails.verified_at')

  if (emails) {
    const normalized = [...new Set(emails.map(normalizeEmail))]
    primary = primary.where('email', 'in', normalized)
    aliases = aliases.where('user_emails.email', 'in', normalized)
  }

  const [users, additional] = await Promise.all([primary.execute(), aliases.execute()])
  return [
    ...users.map(row => ({ id: Number(row.id), handle: String(row.handle), email: normalizeEmail(String(row.email)), primaryEmail: String(row.email) })),
    ...additional.map(row => ({ id: Number(row.id), handle: String(row.handle), email: normalizeEmail(String(row.email)), primaryEmail: String(row.primary_email) })),
  ]
}

/** Ambiguous historical rows must never choose which account receives a login. */
export async function accountForEmail(email: string): Promise<EmailAccount | null> {
  const accounts = await accountsForEmails([email])
  if (new Set(accounts.map(account => account.id)).size !== 1)
    return null
  return accounts[0] ?? null
}

/** Reserve unverified addresses too, so registration cannot take an alias. */
export async function emailIsTaken(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email)
  const primary = await db.selectFrom('users').select(['id']).where('email', '=', normalized).executeTakeFirst()
  if (primary)
    return true
  return Boolean(await db.selectFrom('user_emails').select(['id']).where('email', '=', normalized).executeTakeFirst())
}

/** Reserve primary and secondary addresses in the same unique namespace. */
export async function createAccountWithEmail(values: Record<string, any>): Promise<{ id: number }> {
  const email = normalizeEmail(String(values.email ?? ''))
  return await transaction(async (tx) => {
    const now = dbTimestamp()
    const created = await tx.insertInto('users').values({ ...values, email }).returning(['id']).executeTakeFirst()
    if (!created?.id)
      throw new Error('The account could not be created')
    await tx.insertInto('user_emails').values({
      user_id: Number(created.id), email, verified_at: values.email_verified_at ?? null, created_at: now, updated_at: now,
    }).execute()
    return { id: Number(created.id) }
  })
}

/** Shell operators explicitly attest ownership; ordinary profile edits cannot. */
export async function associateVerifiedEmail(userId: number, email: string): Promise<void> {
  const normalized = normalizeEmail(email)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) || normalized.length > 255)
    throw new Error('Enter a valid email address')

  await transaction(async (tx) => {
    const user = await tx.selectFrom('users').select(['id', 'email']).where('id', '=', userId).lockForUpdate().executeTakeFirst()
    if (!user)
      throw new Error('No such account')
    const primary = await tx.selectFrom('users').select(['id']).where('email', '=', normalized).executeTakeFirst()
    if (primary && Number(primary.id) !== userId)
      throw new Error('That email belongs to another account')
    if (normalizeEmail(String(user.email)) === normalized)
      return
    const alias = await tx.selectFrom('user_emails').select(['id', 'user_id']).where('email', '=', normalized).executeTakeFirst()
    if (alias && Number(alias.user_id) !== userId)
      throw new Error('That email belongs to another account')
    const now = dbTimestamp()
    if (alias)
      await tx.updateTable('user_emails').set({ verified_at: now, updated_at: now }).where('id', '=', Number(alias.id)).execute()
    else
      await tx.insertInto('user_emails').values({ user_id: userId, email: normalized, verified_at: now, created_at: now, updated_at: now }).execute()
  })
}
