/**
 * Every setting an administrator can change without a deploy.
 *
 * One file, and it is the catalogue rather than a helper: the definition of a
 * key, its type, its default and what a wrong value costs all live here, so
 * "what can be configured at runtime?" is a question this file answers rather
 * than a search for reads of a table.
 *
 * ## Nothing here that nothing enforces
 *
 * Each of these is read at the point it applies, and the entry says where. A
 * settings page with a switch that does nothing is worse than no switch: an
 * administrator turns registration off, sees it off, and finds out otherwise
 * from a stranger's account. So the rule for adding one is the rule
 * `app/Actions/Tokens/audit.ts` states for events - a control nothing acts on
 * leaves a reader believing this instance behaves in a way it does not.
 *
 * ## What is deliberately not here
 *
 * The push protection patterns, the database, the queue driver, the mail host.
 * Those are how a deployment is built: versioned with it, reviewed like
 * anything else, and the same on every replica. `config/push-protection.ts`
 * says so in its own words - a regular expression somebody edits at three in
 * the morning through a web form is a scanner that can hang every push.
 *
 * ## Cached, and invalidated on write
 *
 * These are read on paths that run constantly - every registration, every
 * repository creation - and they change perhaps twice in the life of an
 * instance. The cache is per process, so an instance behind several processes
 * takes up to `TTL_MS` to agree with itself after a change. That is stated
 * rather than hidden, and it is the same trade the rate limiter makes: a
 * database read on every request to make a value exact that changes twice a
 * year is the wrong way round.
 */

export type SettingType = 'string' | 'boolean' | 'enum' | 'number'

export interface SettingDefinition {
  type: SettingType
  /** What a fresh instance does. Applies until somebody chooses otherwise. */
  fallback: string
  /** One sentence, shown on the settings page and in the API. */
  describes: string
  /** Where it is enforced, so a reader can check the switch does something. */
  enforcedIn: string
  /** For `enum`, the values allowed. */
  allowed?: readonly string[]
  /** For `number`, the range. */
  min?: number
  max?: number
}

export const SETTINGS = {
  /**
   * Whether a stranger can create an account.
   *
   * `closed` is the setting most self-hosted instances want and most forges
   * make hard to find. There is deliberately no `invite` value: this product
   * has no invitation flow for *registration* - organization invites are a
   * different thing, and they require an account to accept - so an `invite`
   * option would be a mode nobody could use.
   */
  registration: {
    type: 'enum',
    allowed: ['open', 'closed'] as const,
    fallback: 'open',
    describes: 'Whether anybody can create an account on this instance',
    enforcedIn: 'app/Actions/Auth/RegisterAction.ts',
  },

  /**
   * What a new repository is, when the caller does not say.
   *
   * `public` matches what a forge is usually for and is what this defaulted to
   * before there was a setting. A company instance almost always wants
   * `private`, and getting it wrong once is a repository that was public for
   * however long it took somebody to notice - which is exactly the kind of
   * mistake a default should prevent rather than a habit.
   */
  default_repository_visibility: {
    type: 'enum',
    allowed: ['public', 'private', 'internal'] as const,
    fallback: 'public',
    describes: 'What a new repository is when its creator does not choose',
    enforcedIn: 'app/Actions/Repo/CreateRepositoryAction.ts',
  },

  /**
   * How many repositories one account may own.
   *
   * Zero is unlimited, which is the default and what a single-team instance
   * wants. A shared instance with open registration wants a number, because the
   * cost of an account here is not a row - it is a directory on the disk that
   * holds everybody else's work.
   */
  max_repositories_per_user: {
    type: 'number',
    min: 0,
    max: 100_000,
    fallback: '0',
    describes: 'How many repositories one account may own. 0 means no limit.',
    enforcedIn: 'app/Actions/Repo/CreateRepositoryAction.ts',
  },

  /**
   * How long per-execution test history is kept.
   *
   * The one table in this product that grows without a ceiling: a suite of two
   * thousand tests reported on every commit writes two thousand rows per push,
   * so a busy repository produces millions a month. Everything else here is
   * bounded by how much people do - this is bounded by how often a machine
   * does it.
   *
   * A setting rather than a constant because the right number is a property of
   * the instance, not of the software: ninety days covers a release cycle and
   * a bisect through one, and an instance with a small disk and a loud CI
   * wants thirty. Zero keeps everything, which is a choice somebody should be
   * able to make and should have to make deliberately.
   */
  test_retention_days: {
    type: 'number',
    min: 0,
    max: 3650,
    fallback: '90',
    describes: 'Days of per-test execution history kept. 0 keeps everything, and the table then grows without bound.',
    enforcedIn: 'app/Actions/Tests/retention.ts',
  },

  /**
   * Which repositories a workflow may call with `uses:`.
   *
   * `same-owner` is the default and needs no configuration to be safe: an
   * organization calling its own shared workflow is the case people have, and
   * a repository under one owner can already be read by anybody who can read
   * that owner.
   *
   * `instance` widens it to every *public* repository here, which is a real
   * choice an instance for one company might make and a public instance should
   * not. A private repository belonging to another owner is never callable
   * either way: its jobs would run against a definition nobody outside can
   * read, and "I cannot see the file that ran" is a supply-chain problem
   * rather than a convenience.
   */
  workflow_call_scope: {
    type: 'enum',
    allowed: ['same-owner', 'instance'] as const,
    fallback: 'same-owner',
    describes: 'Which repositories a workflow may call: only the same owner\'s, or any public repository on this instance',
    enforcedIn: 'app/Actions/Workflow/reusable.ts',
  },

  /**
   * The name this instance calls itself.
   *
   * Cosmetic, and the one entry here that is. It earns its place because it is
   * the setting every self-hoster changes first and the one they would
   * otherwise have to redeploy for - and because an instance that calls itself
   * ReviewOS in an email to somebody who has never heard of ReviewOS is an
   * email that reads as spam.
   */
  instance_name: {
    type: 'string',
    fallback: 'ReviewOS',
    describes: 'The name shown in the interface and in email this instance sends',
    enforcedIn: 'app/Jobs/SendNotificationJob.ts, app/Jobs/SendDigestJob.ts',
  },

  /**
   * How many bytes of job output this instance will store per second, in total.
   *
   * Backpressure rather than loss. Past this, a chunk is refused with a wait
   * and the runner sends the same one again - which slows the job and keeps its
   * log whole. Dropping the middle instead would be worse than the per-job
   * ceiling's truncation at the end, because a reader cannot tell it happened.
   *
   * Instance-wide rather than per job, because that is where the problem is:
   * one job is bounded by the per-job ceiling anyway, and what makes every
   * other write on the box slow is forty jobs flooding at once.
   *
   * A setting rather than a constant because the right number is a property of
   * the disk underneath, which the person running this knows and this code
   * cannot.
   */
  log_bytes_per_second: {
    type: 'number',
    min: 0,
    max: 1024 * 1024 * 1024,
    fallback: String(8 * 1024 * 1024),
    describes: 'Bytes of job output stored per second across the instance before runners are asked to slow down. 0 means no limit.',
    enforcedIn: 'app/Actions/Runner/logs.ts',
  },
} as const satisfies Record<string, SettingDefinition>

export type SettingKey = keyof typeof SETTINGS

/** How long a process trusts what it last read. */
export const TTL_MS = 30_000

interface Cached {
  values: Record<string, string>
  readAt: number
}

let cache: Cached | null = null

/**
 * Every setting, with defaults filled in.
 *
 * One query for all of them rather than one per key: there are four, a page
 * that shows them wants them all, and a caller that wants one does not care
 * that it read four.
 */
export async function allSettings(now = Date.now()): Promise<Record<SettingKey, string>> {
  if (cache && now - cache.readAt < TTL_MS)
    return withDefaults(cache.values)

  let stored: Record<string, string> = {}

  try {
    const rows: any[] = await (globalThis as any).db
      .selectFrom('instance_settings')
      .select(['key', 'value'])
      .execute()

    for (const row of rows)
      stored[String(row.key)] = String(row.value ?? '')
  }
  catch {
    /*
     * A database that will not answer gives the defaults rather than throwing.
     *
     * This is read on the registration path and the repository creation path,
     * and both have better failure modes of their own for a database that is
     * gone. What must not happen is that a missing table - an instance running
     * a binary newer than its migrations, which is every rolling deploy for a
     * few seconds - turns into a 500 on a page that would otherwise work.
     */
    stored = {}
  }

  cache = { values: stored, readAt: now }

  return withDefaults(stored)
}

/** One setting, already parsed to its type. */
export async function setting<K extends SettingKey>(key: K): Promise<string> {
  return (await allSettings())[key]
}

export async function booleanSetting(key: SettingKey): Promise<boolean> {
  return ['1', 'true', 'on', 'yes'].includes((await setting(key)).toLowerCase())
}

export async function numberSetting(key: SettingKey): Promise<number> {
  const value = Number(await setting(key))

  return Number.isFinite(value) ? value : Number(SETTINGS[key].fallback)
}

export type SettingDecision =
  | { ok: true, key: SettingKey, value: string }
  | { ok: false, error: string, status: number }

/**
 * Whether a proposed value is one this key can hold.
 *
 * Pure, and separate from writing it, so every rule is a unit test rather than
 * something exercised through an endpoint. The messages name the key and the
 * allowed values, because a settings API that answers "invalid" to a script is
 * an API whose author has to read this file.
 */
export function decideSetting(key: string, raw: unknown): SettingDecision {
  if (!isSettingKey(key))
    return { ok: false, error: `No such setting: ${key}`, status: 404 }

  const definition: SettingDefinition = SETTINGS[key]
  const value = String(raw ?? '').trim()

  if (definition.type === 'enum') {
    const allowed = definition.allowed ?? []

    if (!allowed.includes(value))
      return { ok: false, error: `${key} is one of ${allowed.join(', ')}`, status: 422 }

    return { ok: true, key, value }
  }

  if (definition.type === 'number') {
    const parsed = Number(value)
    const min = definition.min ?? 0
    const max = definition.max ?? Number.MAX_SAFE_INTEGER

    if (!Number.isInteger(parsed) || parsed < min || parsed > max)
      return { ok: false, error: `${key} is a whole number from ${min} to ${max}`, status: 422 }

    return { ok: true, key, value: String(parsed) }
  }

  /*
   * No setting is a boolean today - the two switches here happen to be enums,
   * because "open or closed" reads better on a page than a checkbox called
   * "registration". The branch stays because the alternative is that whoever
   * adds the first boolean gets a value stored as `on` and read back as the
   * string `on`, which is truthy and correct until somebody stores `off`.
   */
  if (definition.type === 'boolean')
    return { ok: true, key, value: ['1', 'true', 'on', 'yes'].includes(value.toLowerCase()) ? 'true' : 'false' }

  // A string. Bounded, because it goes into a page title and an email subject,
  // and neither has anywhere to put four hundred characters.
  if (!value)
    return { ok: false, error: `${key} cannot be empty`, status: 422 }

  if (value.length > 100)
    return { ok: false, error: `${key} is at most 100 characters`, status: 422 }

  return { ok: true, key, value }
}

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key)
}

/**
 * Write one, and forget what this process thought it knew.
 *
 * The cache is cleared here rather than left to expire, so the administrator
 * who just changed something sees the change on the next page rather than in
 * half a minute - which is the difference between a setting that works and a
 * setting somebody clicks four times.
 */
export async function writeSetting(key: SettingKey, value: string, actorId: number | null): Promise<void> {
  const db = (globalThis as any).db

  const existing: any = await db
    .selectFrom('instance_settings')
    .select(['id'])
    .where('key', '=', key)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('instance_settings')
      .set({ value, updated_by_id: actorId })
      .where('id', '=', Number(existing.id))
      .execute()
  }
  else {
    await db.insertInto('instance_settings').values({ key, value, updated_by_id: actorId }).execute()
  }

  forgetSettings()
}

/** For a write, and for tests. */
export function forgetSettings(): void {
  cache = null
}

function withDefaults(stored: Record<string, string>): Record<SettingKey, string> {
  const out = {} as Record<SettingKey, string>

  for (const key of Object.keys(SETTINGS) as SettingKey[]) {
    const value = stored[key]

    // An empty stored value falls back rather than being honoured. The only way
    // to get one is a bad write or a hand-edited row, and an instance whose name
    // is the empty string renders a page with no title.
    out[key] = value === undefined || value === '' ? SETTINGS[key].fallback : value
  }

  return out
}
