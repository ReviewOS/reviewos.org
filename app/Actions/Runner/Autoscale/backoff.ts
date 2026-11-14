import { db } from '@stacksjs/database'
import type { AwsWorkerGroupApi, LaunchBackoff, WorkerInstance, WorkerLaunch } from '@stacksjs/ts-cloud/drivers'
import { planLaunchBackoff } from '@stacksjs/ts-cloud/drivers'
import type { OperatorAlert } from '../../../Ops/alerts'
import { alertOperators } from '../../../Ops/alerts'
import type { RunnerGroup } from './types'

/**
 * A runner group whose launches keep ending without a runner: holding it back,
 * and saying so once.
 *
 * ts-cloud decides (`planLaunchBackoff`): three launches in a row that never
 * became workers, and the group launches one probe at a time with a gap that
 * doubles up to `launchBackoffSeconds`. This file supplies what only ReviewOS
 * knows - which launches registered as runners - and tells the operators when
 * the group enters that state and when it leaves it.
 *
 * On 2026-11-13 every instance HQ's group launched died two and a half
 * minutes into its boot, before registering. The scaler launched a
 * replacement every minute for twenty-one hours and the only trace was a log
 * line nobody was reading.
 */

/** Where an alert points: the part of the autoscaling page that says what to do. */
export const BACKOFF_GUIDE = '/docs/autoscaling#when-launches-never-become-runners'

/**
 * What the group's recent launches say, given which of them registered.
 *
 * A runner is named after its EC2 instance and its row outlives the machine,
 * so a launch with a row in `runners` registered and one without never did.
 * Spot is only asked once the launches already look bad: an instance Spot took
 * back before it could register is Spot's failure rather than the boot's, and
 * a healthy group should not cost an EC2 call a minute to learn nothing.
 */
export async function backoffFor(
  api: Pick<AwsWorkerGroupApi, 'interrupted'>,
  group: RunnerGroup,
  launches: WorkerLaunch[],
  instances: WorkerInstance[],
  now: Date,
): Promise<LaunchBackoff & { registered: string[] }> {
  const ids = launches.map(launch => launch.id)
  const registered = ids.length === 0
    ? []
    : (await db.selectFrom('runners').select(['name']).where('name', 'in', ids).execute()).map((runner: any) => String(runner.name))

  const facts = { config: group, launches, instances, registered, now }
  const plan = planLaunchBackoff(facts)
  if (!plan.backingOff)
    return { ...plan, registered }

  let reclaimed: string[] = []
  try {
    reclaimed = [...await api.interrupted(ids.filter(id => !registered.includes(id)))]
  }
  catch {
    // EC2 would not say. The launches are counted as they look: a group that
    // really is dying at boot must not launch freely because an API throttled.
  }
  return { ...(reclaimed.length > 0 ? planLaunchBackoff({ ...facts, reclaimed }) : plan), registered }
}

function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`
}

/** `2026-11-13 21:04 UTC`, for a sentence a person reads. */
function spoken(value: string | null | undefined): string {
  const text = String(value ?? '')
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? `${text.slice(0, 10)} ${text.slice(11, 16)} UTC` : 'an unknown time'
}

/** The command that prints a dead instance's boot output, which EC2 keeps for about an hour. */
export function consoleOutputCommand(region: string, instance: string): string {
  return `aws ec2 get-console-output --region ${region} --instance-id ${instance} --latest --output text`
}

export function backoffAlert(group: RunnerGroup, backoff: Pick<LaunchBackoff, 'died' | 'since' | 'example' | 'nextProbeAt'>): OperatorAlert {
  const since = backoff.since ? stamp(backoff.since) : null
  const next = backoff.nextProbeAt ? stamp(backoff.nextProbeAt) : null
  const where = backoff.example
    ? `Read the boot output of the newest one while EC2 still has it (about an hour): ${consoleOutputCommand(group.region, backoff.example)} - the lines prefixed ts-cloud-worker: say why it quit.`
    : 'Read the boot output of a dead instance in the EC2 console (Actions, Monitor and troubleshoot, Get system log).'
  return {
    event: 'ops:runner-group',
    kind: 'problem',
    title: `Runner group ${group.name}: ${backoff.died} launches in a row never became runners (since ${spoken(since)})`,
    detail: `Every instance ${group.name} (${group.region}) launched since ${spoken(since)} ended without registering as a runner, so jobs for ${group.repositories.join(', ')} are waiting. Launches are held back to one probe at a time, with up to ${Math.round((group.launchBackoffSeconds ?? 1800) / 60)} minutes between them; the next is due at ${spoken(next)}. Scaling returns to normal as soon as one registers. ${where}`,
    url: BACKOFF_GUIDE,
    context: { group: group.name, region: group.region, died: backoff.died, since, example: backoff.example, nextProbeAt: next },
  }
}

export function recoveryAlert(group: RunnerGroup, incident: { died: number, since: string | null, registered: string | null }): OperatorAlert {
  const how = incident.registered ? `${incident.registered} registered as a runner` : 'its launches are no longer held back'
  return {
    event: 'ops:runner-group',
    kind: 'recovered',
    title: `Runner group ${group.name} is launching runners again`,
    detail: `${how}, after ${incident.died} launches in a row that never did (since ${spoken(incident.since)}). ${group.name} scales normally again.`,
    url: BACKOFF_GUIDE,
    context: { group: group.name, region: group.region, died: incident.died, since: incident.since, registered: incident.registered },
  }
}

/** The group's row in `runner_group_backoffs`, as the scaler reads and writes it. */
export interface BackoffRecord {
  died: number
  since: string | null
  example: string | null
  next_probe_at: string | null
  alerted_at: string | null
  recovered_at: string | null
}

/**
 * What one tick does to the group's record, and whether anybody is told.
 *
 * Pure, so the rule that matters - one alert when an incident opens, one
 * notice when it ends, and nothing on any tick in between - is tested without
 * a database. `write` is null when the record already says what this tick saw.
 */
export function backoffStep(
  record: BackoffRecord | null,
  backoff: Pick<LaunchBackoff, 'backingOff' | 'died' | 'since' | 'example' | 'nextProbeAt'>,
  now: Date,
): { write: BackoffRecord | null, tell: 'problem' | 'recovered' | null } {
  const open = record !== null && !record.recovered_at

  if (backoff.backingOff) {
    const seen = {
      since: backoff.since ? stamp(backoff.since) : null,
      example: backoff.example,
      next_probe_at: backoff.nextProbeAt ? stamp(backoff.nextProbeAt) : null,
    }
    if (!open)
      return { write: { died: backoff.died, ...seen, alerted_at: stamp(now), recovered_at: null }, tell: 'problem' }

    // The launch record is one page deep, so the run it shows can stop growing
    // while the incident goes on. The row keeps the most it has seen and the
    // earliest start.
    const died = Math.max(record.died, backoff.died)
    const since = record.since && seen.since && record.since < seen.since ? record.since : seen.since
    const same = died === record.died && since === record.since && seen.example === record.example && seen.next_probe_at === record.next_probe_at
    return { write: same ? null : { ...record, died, since, example: seen.example, next_probe_at: seen.next_probe_at }, tell: null }
  }

  if (!open)
    return { write: null, tell: null }
  return { write: { ...record, next_probe_at: null, recovered_at: stamp(now) }, tell: 'recovered' }
}

/** Where a group's record is kept. The database, except in a test of the rule above. */
export interface BackoffStore {
  read: (group: string) => Promise<BackoffRecord | null>
  /** False when another tick created the record first. */
  create: (group: string, record: BackoffRecord) => Promise<boolean>
  update: (group: string, record: BackoffRecord) => Promise<void>
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

export const databaseBackoffStore: BackoffStore = {
  async read(group) {
    const row: any = await db
      .selectFrom('runner_group_backoffs')
      .select(['died', 'since', 'example', 'next_probe_at', 'alerted_at', 'recovered_at'])
      .where('group_name', '=', group)
      .executeTakeFirst()
    return row
      ? { died: Number(row.died ?? 0), since: text(row.since), example: text(row.example), next_probe_at: text(row.next_probe_at), alerted_at: text(row.alerted_at), recovered_at: text(row.recovered_at) }
      : null
  },
  async create(group, record) {
    try {
      await db.insertInto('runner_group_backoffs').values({ group_name: group, ...record }).execute()
      return true
    }
    catch {
      // The unique index on the group's name.
      return false
    }
  },
  async update(group, record) {
    await db.updateTable('runner_group_backoffs').set({ ...record }).where('group_name', '=', group).execute()
  },
}

/**
 * Keep the group's record in step with what this tick saw, and tell the
 * operators on the two ticks where that changes: the one that opens an
 * incident and the one that ends it.
 *
 * The record is written before anybody is told, so the alert survives a
 * restart as "already sent" rather than as something to send again, and a
 * second scheduler that loses the race to create the record stays quiet. The
 * cost is the other way round: a process that dies between the write and the
 * alert sends none. The line a held group prints on every tick with work
 * waiting is what covers that.
 */
export async function noteBackoff(
  group: RunnerGroup,
  backoff: LaunchBackoff,
  options: { now: Date, registered?: string | null, tell?: (alert: OperatorAlert) => Promise<unknown>, store?: BackoffStore },
): Promise<string[]> {
  const tell = options.tell ?? alertOperators
  const store = options.store ?? databaseBackoffStore
  const record = await store.read(group.name)
  const step = backoffStep(record, backoff, options.now)
  if (!step.write)
    return []

  if (record)
    await store.update(group.name, step.write)
  else if (!await store.create(group.name, step.write))
    return []

  if (step.tell === 'problem') {
    await tell(backoffAlert(group, backoff))
    return [`${group.name}: told the operators that ${backoff.died} launch(es) in a row never became runners`]
  }
  if (step.tell === 'recovered') {
    const died = record?.died ?? 0
    await tell(recoveryAlert(group, { died, since: record?.since ?? null, registered: options.registered ?? null }))
    return [`${group.name}: launching runners again${options.registered ? ` (${options.registered} registered)` : ''} after ${died} launch(es) that never did; told the operators`]
  }
  return []
}
