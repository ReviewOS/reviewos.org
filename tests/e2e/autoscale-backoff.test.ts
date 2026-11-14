// A runner group whose launches never become runners, through the real tick.
//
// `tests/unit/autoscale-backoff.test.ts` replays the 2026-11-13 incident
// against the decisions alone. This runs `tickGroup` against the real tables
// with AWS stood in for: which launches registered is a query on `runners`,
// that somebody was told is a row in `runner_group_backoffs`, and what they
// were told is a row in an administrator's inbox.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, adminId: 0, repositoryId: 0, workflowId: 0, versionId: 0, handle: '', name: '', group: '' }
const runnerIds: number[] = []

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const start = new Date('2026-11-13T21:04:00Z')
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000)

function group(): any {
  return {
    name: created.group,
    region: 'us-east-1',
    repositories: [`${created.handle}/${created.name}`],
    labels: ['ubuntu-latest', 'self-hosted', 'aws'],
    min: 0,
    max: 6,
    registrationGraceSeconds: 900,
    launchBackoffSeconds: 1800,
  }
}

/** An Auto Scaling group that launches what it is asked for, and remembers it. */
function aws() {
  const cloud = {
    launches: [] as Array<{ id: string, at: Date }>,
    up: new Set<string>(),
    reclaimed: new Set<string>(),
    asked: [] as number[],
    now: start,
    api: {
      region: 'us-east-1',
      launches: async () => [...cloud.launches].sort((a, b) => b.at.getTime() - a.at.getTime()),
      describeGroup: async () => ({
        desired: cloud.up.size,
        min: 0,
        max: 6,
        onDemandPercentage: null,
        instances: cloud.launches.filter(launch => cloud.up.has(launch.id)).map(launch => ({ id: launch.id, lifecycle: 'InService', launchedAt: launch.at })),
      }),
      setDesired: async (_name: string, desired: number) => {
        cloud.asked.push(desired)
        while (cloud.up.size < desired) {
          const id = `i-${unique('').padEnd(17, '0')}`
          cloud.launches.push({ id, at: cloud.now })
          cloud.up.add(id)
        }
      },
      terminate: async (id: string) => { cloud.up.delete(id) },
      interrupted: async (ids: string[]) => new Set(ids.filter(id => cloud.reclaimed.has(id))),
      spotTrouble: async () => ({ refused: [], interrupted: new Map() }),
      setOnDemandShare: async () => {},
    } as any,
    /** Every instance that is up quits, the way one whose boot failed does. */
    die() {
      cloud.up.clear()
    },
  }
  return cloud
}

async function tick(cloud: ReturnType<typeof aws>, now: Date): Promise<string[]> {
  const { tickGroup } = await import('../../app/Actions/Runner/Autoscale/tick')
  cloud.now = now
  return tickGroup(cloud.api, group(), { now })
}

async function aRunner(name: string): Promise<void> {
  const runner: any = await db.insertInto('runners').values({
    name,
    scope_type: 'instance',
    scope_id: null,
    token_hash: unique('hash').padEnd(64, '0').slice(0, 64),
    labels: 'ubuntu-latest\nself-hosted\naws',
    state: 'active',
    version: '1',
    last_seen_at: new Date().toISOString(),
  }).returning(['id']).executeTakeFirst()
  runnerIds.push(Number(runner.id))
}

async function inbox(): Promise<Array<{ title: string, url: string, reason: string, detail: string }>> {
  const rows = await db.selectFrom('notifications').select(['id', 'data']).where('user_id', '=', created.adminId).where('type', '=', 'ops:runner-group').orderBy('id', 'asc').execute()
  return rows.map((row: any) => JSON.parse(String(row.data))).filter((data: any) => String(data.title).includes(created.group))
}

async function record(): Promise<any> {
  return db.selectFrom('runner_group_backoffs').select(['died', 'since', 'example', 'next_probe_at', 'alerted_at', 'recovered_at']).where('group_name', '=', created.group).executeTakeFirst()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('runner_group_backoffs').select(['id']).limit(1).execute()

    created.handle = unique('backoff')
    created.group = unique('reviewos-runner-test-')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Backoff', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.ownerId = Number(owner?.id)

    const admin: any = await db.insertInto('users')
      .values({ name: 'Operator', email: `${created.handle}-admin@example.com`, handle: `${created.handle}-admin`, password: 'x', is_admin: true })
      .returning(['id']).executeTakeFirst()
    created.adminId = Number(admin?.id)

    created.name = unique('repo')
    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    }).returning(['id']).executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.reviewos/workflows/ci.ts',
      name: 'CI',
      state: 'active',
    }).returning(['id']).executeTakeFirst()
    created.workflowId = Number(workflow.id)

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: created.workflowId,
      source_sha: 'f'.repeat(40),
      source_path: '.reviewos/workflows/ci.ts',
      content_digest: unique('digest').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).returning(['id']).executeTakeFirst()
    created.versionId = Number(version.id)

    // Three jobs waiting for the group, for as long as the test runs.
    for (let job = 0; job < 3; job++) {
      const run: any = await db.insertInto('workflow_runs').values({
        workflow_version_id: created.versionId,
        repository_id: created.repositoryId,
        number: Math.floor(Math.random() * 1_000_000),
        state: 'queued',
        event: 'push',
        event_ref: 'refs/heads/main',
        head_sha: 'f'.repeat(40),
        definition_sha: 'f'.repeat(40),
        trusted: true,
      }).returning(['id']).executeTakeFirst()

      await db.insertInto('workflow_jobs').values({
        workflow_run_id: Number(run.id),
        repository_id: created.repositoryId,
        job_id: unique('job'),
        name: 'test',
        position: 1,
        state: 'queued',
        runs_on: 'ubuntu-latest\nself-hosted',
        kind: 'command',
      }).execute()
    }
    available = true
  }
  catch (error) {
    console.warn(`[autoscale-backoff] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  if (!available || !db)
    return

  if (runnerIds.length > 0)
    await db.deleteFrom('runners').where('id', 'in', runnerIds).execute().catch(() => null)
  await db.deleteFrom('runner_group_backoffs').where('group_name', '=', created.group).execute().catch(() => null)
  await db.deleteFrom('notification_deliveries').where('user_id', '=', created.adminId).execute().catch(() => null)
  await db.deleteFrom('notifications').where('user_id', '=', created.adminId).execute().catch(() => null)
  await db.deleteFrom('workflows').where('id', '=', created.workflowId).execute().catch(() => null)
  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => null)
  await db.deleteFrom('users').where('id', 'in', [created.ownerId, created.adminId]).execute().catch(() => null)
})

describe('a runner group whose launches never register', () => {
  const cloud = aws()

  test('launches for the queue while nothing has gone wrong', async () => {
    if (!available)
      return

    const lines = await tick(cloud, at(0))
    expect(cloud.launches).toHaveLength(3)
    expect(lines.join('\n')).toContain('3 waiting, 0 arriving, 0 idle: asking for 3 more')
    expect(await record()).toBeUndefined()
    expect(await inbox()).toHaveLength(0)
  }, 120_000)

  test('three dead launches: one probe at a time, and the administrator is told once', async () => {
    if (!available)
      return

    cloud.die()
    const lines = await tick(cloud, at(3))
    // Two minutes after the last launch have passed, so a probe goes out: one, not three.
    expect(cloud.launches).toHaveLength(4)
    expect(lines.join('\n')).toContain('3 launch(es) in a row ended without a worker since 2026-11-13T21:04:00Z: probing with one instance')
    expect(lines.join('\n')).toContain('told the operators that 3 launch(es) in a row never became runners')

    expect(await record()).toMatchObject({ died: 3, since: '2026-11-13T21:04:00Z', alerted_at: '2026-11-13T21:07:00Z', recovered_at: null })

    const told = await inbox()
    expect(told).toHaveLength(1)
    expect(told[0]!.title).toBe(`Runner group ${created.group}: 3 launches in a row never became runners (since 2026-11-13 21:04 UTC)`)
    expect(told[0]!.url).toBe('/docs/autoscaling#when-launches-never-become-runners')
    expect(told[0]!.reason).toBe('administrator')
    expect(told[0]!.detail).toContain('aws ec2 get-console-output --region us-east-1 --instance-id i-')
  }, 120_000)

  test('while it lasts: nothing launches between probes, the log says when the next one is, nobody is told again', async () => {
    if (!available)
      return

    // The probe is up and has not registered: wait for its verdict.
    let lines = await tick(cloud, at(4))
    expect(cloud.launches).toHaveLength(4)
    expect(lines.join('\n')).toContain(`waiting to see whether probe ${cloud.launches.at(-1)!.id} registers`)

    // It dies too. Four in a row: four minutes after its launch, not before.
    cloud.die()
    lines = await tick(cloud, at(6))
    expect(cloud.launches).toHaveLength(4)
    expect(lines.join('\n')).toContain('4 launch(es) in a row ended without a worker since 2026-11-13T21:04:00Z: backing off, next probe at 2026-11-13T21:11:00Z')

    lines = await tick(cloud, at(7))
    expect(cloud.launches).toHaveLength(5)

    // Hours of it: every probe dies, and the gap settles at the cap.
    for (let minute = 8; minute <= 240; minute++) {
      if (cloud.up.size > 0 && at(minute).getTime() - cloud.launches.at(-1)!.at.getTime() >= 150_000)
        cloud.die()
      await tick(cloud, at(minute))
    }
    // 3 at once, then probes at +3, +7, +15, +31 and every 30 minutes after: not one a minute.
    expect(cloud.launches.length).toBeLessThan(16)
    const last = cloud.launches.slice(-2)
    expect((last[1]!.at.getTime() - last[0]!.at.getTime()) / 60_000).toBe(30)

    expect(await inbox()).toHaveLength(1)
    const row = await record()
    expect(Number(row.died)).toBe(cloud.launches.length - (cloud.up.size > 0 ? 1 : 0))
    expect(row.recovered_at).toBeNull()
  }, 240_000)

  test('the metrics say so, from a process that never ran a tick', async () => {
    if (!available)
      return

    const { autoscalingGroups } = await import('../../cloud/autoscaling')
    const { collectFromDatabase, render, resetMetrics } = await import('../../app/Ops/metrics')
    const declared = autoscalingGroups['hq-aws']!
    const original = declared.name
    declared.name = created.group
    try {
      resetMetrics()
      await collectFromDatabase()
      const row = await record()
      expect(render()).toContain(`reviewos_autoscale_backing_off{group="${created.group}"} 1`)
      expect(render()).toContain(`reviewos_autoscale_launches_unregistered{group="${created.group}"} ${Number(row.died)}`)
    }
    finally {
      declared.name = original
      resetMetrics()
    }
  }, 120_000)

  test('a probe registers: scaling is normal on the next tick, and the administrator is told once more', async () => {
    if (!available)
      return

    // Run on to the next probe, and let this one register as a runner.
    let minute = 241
    const before = cloud.launches.length
    while (cloud.launches.length === before) {
      if (cloud.up.size > 0 && at(minute).getTime() - cloud.launches.at(-1)!.at.getTime() >= 150_000)
        cloud.die()
      await tick(cloud, at(minute++))
    }
    const probe = cloud.launches.at(-1)!.id
    await aRunner(probe)

    const lines = await tick(cloud, at(minute))
    // The probe is an idle runner and takes one job; the other two get machines at once.
    expect(cloud.launches).toHaveLength(before + 3)
    expect(lines.join('\n')).toContain(`launching runners again (${probe} registered)`)

    const row = await record()
    expect(row.recovered_at).toBe(`${at(minute).toISOString().slice(0, 19)}Z`)
    expect(row.next_probe_at).toBeNull()

    const told = await inbox()
    expect(told).toHaveLength(2)
    expect(told[1]!.title).toBe(`Runner group ${created.group} is launching runners again`)
    expect(told[1]!.detail).toContain(`${probe} registered as a runner`)

    // And it stays said once.
    await tick(cloud, at(minute + 1))
    await tick(cloud, at(minute + 2))
    expect(await inbox()).toHaveLength(2)

    const { collectFromDatabase, render, resetMetrics } = await import('../../app/Ops/metrics')
    const { autoscalingGroups } = await import('../../cloud/autoscaling')
    const declared = autoscalingGroups['hq-aws']!
    const original = declared.name
    declared.name = created.group
    try {
      resetMetrics()
      await collectFromDatabase()
      expect(render()).toContain(`reviewos_autoscale_backing_off{group="${created.group}"} 0`)
      expect(render()).toContain(`reviewos_autoscale_launches_unregistered{group="${created.group}"} 0`)
    }
    finally {
      declared.name = original
      resetMetrics()
    }
  }, 240_000)
})

describe('a group Spot is taking machines from', () => {
  test('is not held back, and nobody is told the boot is broken', async () => {
    if (!available)
      return

    const original = created.group
    created.group = unique('reviewos-runner-spot-')
    try {
      const cloud = aws()
      await tick(cloud, at(0))
      expect(cloud.launches).toHaveLength(3)
      // Spot reclaims all three before any registers.
      for (const launch of cloud.launches)
        cloud.reclaimed.add(launch.id)
      cloud.die()

      const lines = await tick(cloud, at(3))
      expect(cloud.launches).toHaveLength(6)
      expect(lines.join('\n')).toContain('asking for 3 more')
      expect(lines.join('\n')).not.toContain('ended without a worker')
      expect(await record()).toBeUndefined()
      expect(await inbox()).toHaveLength(0)
    }
    finally {
      created.group = original
    }
  }, 120_000)
})
