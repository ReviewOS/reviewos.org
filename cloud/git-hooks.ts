import { createHmac } from 'node:crypto'

/** A stable, purpose-specific hook credential; never reuse the application key itself. */
export function deploymentHookSecret(appKey: string, explicit = ''): string {
  if (explicit.trim().length >= 16) return explicit.trim()
  if (explicit.trim()) throw new Error('GIT_HOOK_SECRET must contain at least 16 characters')
  if (appKey.length < 16) return ''
  return createHmac('sha256', appKey).update('reviewos/git-hook/v1').digest('hex')
}
