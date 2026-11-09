import type { CLI } from '@stacksjs/types'
import { hostname, userInfo } from 'node:os'
import process from 'node:process'
import { db } from '@stacksjs/database'
import { bootAppListeners } from '@stacksjs/events'
import type { IssuedAccessToken } from '../Actions/Tokens/issue'
import { issueAccessToken, readableRepositories, revokeAccessToken } from '../Actions/Tokens/issue'
import { resolveOwner, resolveRepository } from '../Actions/Identity/lookup'
import { INSTANCE_SCOPES, normalizeGrants, ORGANIZATION_SCOPES, REPOSITORY_SCOPES, TOKEN_LEVELS } from '../TokenScopes'

/**
 * Issue and revoke access tokens from the instance's shell.
 *
 * The bootstrap the API cannot be: minting a token over HTTP needs a signed-in
 * account, and the automation that wants one (HQ's CI cancelling superseded
 * runs, a mirror's sync, a deploy script) has a shell on the box and nothing
 * else. Until these existed it inserted rows into `access_tokens` by hand, with
 * no check that the owner could read the repositories it named and no audit
 * line saying the token had been born.
 *
 * Both go through the same functions the settings page and the API use
 * (`Actions/Tokens/issue.ts`), so the rules are the same rules. What is
 * different is who acted: an operator, recorded as `cli:<user>@<host>` rather
 * than as an account somebody did not sign in to.
 *
 *   buddy token:create --user chris@example.com --name "HQ CI" \
 *     --repository stacks/hq.training --permission actions:write \
 *     --permission actions_logs:read --expires-in-days 1
 *   buddy token:revoke 12 --reason "rotated"
 *
 * The token is printed once, alone on stdout, so `TOKEN=$(buddy token:create
 * ...)` captures exactly it; everything else goes to stderr.
 */

export interface CreateTokenOptions {
  user?: string
  name?: string
  repository?: string | string[]
  organization?: string
  all?: boolean
  permission?: string | string[]
  expiresInDays?: string | number
  json?: boolean
}

export type CommandResult<T> = { ok: true, value: T } | { ok: false, error: string }

/** Who acted, for the audit log, when it was a person at this machine's shell. */
export function operator(): string {
  let name = ''
  try {
    name = userInfo().username
  }
  catch { /* no passwd entry, as in some containers */ }

  return `cli:${name || 'unknown'}@${hostname()}`
}

/** A repeatable option, however the parser handed it over. */
function many(value: string | string[] | undefined): string[] {
  return [value ?? []].flat().map(item => String(item).trim()).filter(Boolean)
}

/**
 * `scope:level` pairs, refused rather than dropped when one is not a grant.
 *
 * The API drops unknown scopes so a client built against a newer instance
 * still gets a working token. A person typing `--permission action:write` at a
 * shell is better served by being told: a silently missing grant is a token
 * that fails later, somewhere else.
 */
export function parsePermissions(values: string[]): CommandResult<{ scope: string, level: string }[]> {
  const known = new Set<string>([...REPOSITORY_SCOPES, ...ORGANIZATION_SCOPES, ...INSTANCE_SCOPES])
  const grants: { scope: string, level: string }[] = []

  for (const value of values) {
    const [scope = '', level = '', ...rest] = value.split(':').map(part => part.trim())

    if (!scope || !level || rest.length > 0)
      return { ok: false, error: `\`${value}\` is not a permission; write scope:level, for example actions:write` }

    if (!known.has(scope))
      return { ok: false, error: `\`${scope}\` is not a token scope. Known scopes: ${[...known].sort().join(', ')}` }

    if (!(TOKEN_LEVELS as readonly string[]).includes(level))
      return { ok: false, error: `\`${level}\` is not a level; use ${TOKEN_LEVELS.join(', ')}` }

    grants.push({ scope, level })
  }

  if (normalizeGrants(grants).length === 0)
    return { ok: false, error: 'Give the token at least one --permission scope:level' }

  return { ok: true, value: grants }
}

/** An account by email (primary or verified alias) or by handle. */
async function findUser(who: string): Promise<{ id: number, handle: string } | null> {
  const wanted = who.trim().toLowerCase()
  if (!wanted)
    return null

  const direct: any = await db
    .selectFrom('users')
    .select(['id', 'handle'])
    .where(wanted.includes('@') ? 'email' : 'handle', '=', wanted)
    .executeTakeFirst()

  if (direct)
    return { id: Number(direct.id), handle: String(direct.handle) }

  if (!wanted.includes('@'))
    return null

  const alias: any = await db
    .selectFrom('user_emails')
    .innerJoin('users', 'users.id', '=', 'user_emails.user_id')
    .select(['users.id as id', 'users.handle as handle'])
    .where('user_emails.email', '=', wanted)
    .whereNotNull('user_emails.verified_at')
    .executeTakeFirst()
    .catch(() => null)

  return alias ? { id: Number(alias.id), handle: String(alias.handle) } : null
}

/** Everything `token:create` does short of printing, so a test can call it. */
export async function createTokenFromCli(options: CreateTokenOptions, nowMs: number = Date.now()): Promise<CommandResult<IssuedAccessToken & { owner: string }>> {
  const user = await findUser(String(options.user ?? ''))
  if (!user)
    return { ok: false, error: 'Say whose token this is with --user <email or handle>, for an account that exists' }

  const permissions = parsePermissions(many(options.permission))
  if (!permissions.ok)
    return permissions

  const repositories = many(options.repository)
  const organization = String(options.organization ?? '').trim()
  const chosen = [repositories.length > 0, Boolean(organization), Boolean(options.all)].filter(Boolean).length

  if (chosen !== 1)
    return { ok: false, error: 'Say what the token reaches: one or more --repository owner/name, --organization <handle>, or --all' }

  const repositoryIds: number[] = []
  for (const named of repositories) {
    const [owner, name, ...rest] = named.split('/')
    const row = owner && name && rest.length === 0 ? await resolveRepository(owner, name) : null

    if (!row)
      return { ok: false, error: `No repository \`${named}\`; write owner/name` }

    repositoryIds.push(Number(row.id))
  }

  /*
   * Repositories the owner cannot read are filtered out by the shared rules,
   * which is right for a script holding a stale id and wrong for a person who
   * named one: the token would reach less than they asked for, silently. So
   * the command refuses before anything is issued.
   */
  const readable = await readableRepositories(repositoryIds, user.id)
  const unreadable = repositories.filter((_, index) => !readable.includes(repositoryIds[index]!))
  if (unreadable.length > 0)
    return { ok: false, error: `${user.handle} cannot read ${unreadable.join(', ')}, so no token was issued` }

  let organizationId: number | null = null
  if (organization) {
    const owner = await resolveOwner(organization)

    if (!owner || owner.kind !== 'organization')
      return { ok: false, error: `No organization \`${organization}\`` }

    organizationId = owner.id
  }

  let expiresAtMs: number | null = null
  if (options.expiresInDays !== undefined && options.expiresInDays !== '') {
    const days = Number(options.expiresInDays)

    if (!Number.isFinite(days) || days <= 0)
      return { ok: false, error: '--expires-in-days has to be a positive number of days' }

    expiresAtMs = nowMs + days * 86_400_000
  }

  const issued = await issueAccessToken({
    userId: user.id,
    name: String(options.name ?? ''),
    selection: options.all ? 'all' : organizationId ? 'organization' : 'selected',
    organizationId,
    repositoryIds,
    permissions: permissions.value,
    expiresAtMs,
    // Nobody signed in: the operator is the actor, not the owner.
    actorId: null,
    externalActor: operator(),
    detail: { issued_from: 'cli' },
    nowMs,
  })

  if (!issued.ok)
    return { ok: false, error: issued.error }

  return { ok: true, value: { ...issued.token, owner: user.handle } }
}

/** Everything `token:revoke` does short of printing. */
export async function revokeTokenFromCli(id: number, reason: string | null): Promise<CommandResult<{ id: number, revokedAt: string, alreadyRevoked: boolean }>> {
  if (!Number.isInteger(id) || id <= 0)
    return { ok: false, error: 'A token id is a positive whole number (the `id` token:create printed)' }

  const token: any = await db
    .selectFrom('access_tokens')
    .select(['id', 'user_id', 'prefix'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!token)
    return { ok: false, error: `No token ${id}` }

  const revoked = await revokeAccessToken({
    id,
    ownerId: Number(token.user_id),
    prefix: token.prefix ? String(token.prefix) : null,
    actorId: null,
    externalActor: operator(),
    reason: reason?.trim() || null,
    detail: { by_owner: false, revoked_from: 'cli' },
  })

  return { ok: true, value: { id, ...revoked } }
}

function fail(message: string): void {
  console.error(message)
  process.exit(1)
}

export default function (cli: CLI) {
  cli
    .command('token:create', 'Issue an access token for an account, printing it once')
    .option('--user <email|handle>', 'The account the token acts as')
    .option('--name <name>', 'What the token is for, shown on the settings page')
    .option('--repository <owner/name>', 'A repository it reaches. Repeatable.')
    .option('--organization <handle>', 'Reach every repository of this organization instead')
    .option('--all', 'Reach everything the account can', { default: false })
    .option('--permission <scope:level>', 'A grant such as actions:write. Repeatable.')
    .option('--expires-in-days <days>', 'Lifetime in days (default 90, at most 365)')
    .option('--json', 'Print the whole token as JSON instead of the secret alone', { default: false })
    .action(async (options: CreateTokenOptions) => {
      // The token audit trail is written by the application's listeners, which a
      // shell command has not booted; without them issuance went unrecorded.
      await bootAppListeners()
      const created = await createTokenFromCli(options)
      if (!created.ok)
        return fail(created.error)

      const token = created.value
      if (options.json) {
        console.log(JSON.stringify(token, null, 2))
        return
      }

      console.error(`Token ${token.id} (${token.prefix}) for ${token.owner}: ${token.permissions.map(grant => `${grant.scope}:${grant.level}`).join(', ')}, expires ${token.expires_at}.`)
      console.error('This is the only time it is shown; it is stored as a hash.')
      console.log(token.token)
    })

  cli
    .command('token:revoke <id>', 'Revoke an access token by id; it stops working on the next request')
    .option('--reason <reason>', 'Why, for the audit log')
    .action(async (id: string, options: { reason?: string }) => {
      await bootAppListeners()
      const revoked = await revokeTokenFromCli(Number(id), options.reason ?? null)
      if (!revoked.ok)
        return fail(revoked.error)

      console.log(revoked.value.alreadyRevoked
        ? `Token ${revoked.value.id} was already revoked at ${revoked.value.revokedAt}.`
        : `Revoked token ${revoked.value.id}.`)
    })
}
