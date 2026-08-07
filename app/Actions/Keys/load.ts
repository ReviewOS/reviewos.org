/**
 * The keys an account has registered, ready to draw.
 *
 * Shaped here rather than in the template: which parts of a key are safe and
 * useful to show is a judgement, not formatting. **The public key body is never
 * sent to the page.** It is public, so nothing is leaked by it - but a settings
 * screen listing six keys in full is unreadable, and the fingerprint is the
 * thing a person actually compares against what `ssh-keygen -l` prints.
 */

import { db } from '@stacksjs/database'
import { emailsOf } from '../Git/signature'

export interface RegisteredSshKey {
  id: number
  title: string
  type: string
  fingerprint: string
  /** ISO, or null for a key that has never been used to push. */
  lastUsedAt: string | null
  addedAt: string | null
}

export interface RegisteredGpgKey {
  id: number
  /** The long key id, which is what gpg and GitHub both show. */
  keyId: string
  emails: string[]
  expiresAt: string | null
  addedAt: string | null
}

export interface RegisteredKeys {
  ssh: RegisteredSshKey[]
  gpg: RegisteredGpgKey[]
}

/** Both lists for one account, newest first. */
export async function keysFor(userId: number): Promise<RegisteredKeys> {
  if (!Number.isInteger(userId) || userId <= 0)
    return { ssh: [], gpg: [] }

  const [ssh, gpg] = await Promise.all([
    db.selectFrom('ssh_keys')
      .select(['id', 'title', 'key_type', 'fingerprint', 'last_used_at', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('id', 'desc')
      .execute(),
    db.selectFrom('gpg_keys')
      .select(['id', 'key_id', 'emails', 'expires_at', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('id', 'desc')
      .execute(),
  ])

  return {
    ssh: ssh.map((row: any) => ({
      id: Number(row.id),
      title: String(row.title ?? 'SSH key'),
      type: String(row.key_type ?? ''),
      fingerprint: String(row.fingerprint ?? ''),
      lastUsedAt: iso(row.last_used_at),
      addedAt: iso(row.created_at),
    })),
    gpg: gpg.map((row: any) => ({
      id: Number(row.id),
      // Shown as the last sixteen: the column holds the full fingerprint,
      // because `sameKey` matches by suffix and the longer form is the one that
      // cannot collide. The short form is what a person recognises.
      keyId: String(row.key_id ?? '').slice(-16),
      emails: emailsOf(row.emails),
      expiresAt: iso(row.expires_at),
      addedAt: iso(row.created_at),
    })),
  }
}

/**
 * Whether a GPG key has passed its expiry.
 *
 * Computed on read rather than stored: a key expires by the calendar, so a
 * column saying "expired" is a column that is wrong from the moment it is
 * written until something happens to rewrite it.
 */
export function hasExpired(expiresAt: string | null, now: Date = new Date()): boolean {
  if (!expiresAt)
    return false

  const when = new Date(expiresAt)

  return !Number.isNaN(when.getTime()) && when <= now
}

function iso(value: unknown): string | null {
  if (!value)
    return null

  const when = new Date(value as string)

  return Number.isNaN(when.getTime()) ? null : when.toISOString()
}

export interface RegisteredDeployKey {
  id: number
  title: string
  type: string
  fingerprint: string
  canWrite: boolean
  lastUsedAt: string | null
  addedAt: string | null
}

/**
 * One repository's deploy keys, newest first.
 *
 * Same rule as the account keys: the public key body never reaches the page.
 * The fingerprint is what somebody compares against what `ssh-keygen -l` prints
 * on the machine that is supposed to be holding it.
 */
export async function deployKeysFor(repositoryId: number): Promise<RegisteredDeployKey[]> {
  if (!Number.isInteger(repositoryId) || repositoryId <= 0)
    return []

  const rows = await db
    .selectFrom('deploy_keys')
    .select(['id', 'title', 'key_type', 'fingerprint', 'can_write', 'last_used_at', 'created_at'])
    .where('repository_id', '=', repositoryId)
    .orderBy('id', 'desc')
    .execute()

  return rows.map((row: any) => ({
    id: Number(row.id),
    title: String(row.title ?? 'Deploy key'),
    type: String(row.key_type ?? ''),
    fingerprint: String(row.fingerprint ?? ''),
    canWrite: Boolean(row.can_write),
    lastUsedAt: iso(row.last_used_at),
    addedAt: iso(row.created_at),
  }))
}
