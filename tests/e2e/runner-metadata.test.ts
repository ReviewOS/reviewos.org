// The values one run's jobs pass to each other.
//
// The interesting half is the compare-and-set: two parallel jobs that each read
// and write the same key must not lose one another's contribution. That cannot
// be tested with a fixture and a mock, because the guard is a `WHERE` clause -
// so this runs against the real table.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { listMetadata, readMetadata, writeMetadata } from '../../app/Actions/Runner/metadata'

const created = { ownerId: 0, repositoryId: 0, versionId: 0, runId: 0, otherRunId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function makeRun(number: number): Promise<number> {
  const row: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.repositoryId,
    number,
    state: 'running',
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: unique('s').padEnd(40, '0').slice(0, 40),
    definition_sha: 'b'.repeat(40),
    trusted: true,
  }).returning(['id']).executeTakeFirst()

  return Number(row.id)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('meta')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Meta', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.github/workflows/ci.yml',
      name: 'CI',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: Number(workflow.id),
      source_sha: 'a'.repeat(40),
      source_path: '.github/workflows/ci.yml',
      content_digest: unique('d').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    created.versionId = Number(version.id)
    created.runId = await makeRun(1)
    created.otherRunId = await makeRun(2)

    available = true
  }
  catch (error) {
    console.warn(`[run-metadata] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('passing a value between jobs', () => {
  test('a job writes it, and any job in the run reads it', async () => {
    if (!available)
      return

    // The case the feature is for: a build computes a version and a deploy that
    // never declared `needs:` on it still gets the number.
    const written = await writeMetadata({ runId: created.runId, key: 'version', value: '1.4.2' })

    expect(written.ok).toBe(true)
    expect((await readMetadata(created.runId, 'version'))?.value).toBe('1.4.2')
  }, 120_000)

  test('and another run cannot see it', async () => {
    if (!available)
      return

    /*
     * Two runs of the same workflow are different commits. A deploy that read
     * the other run's version number would ship the wrong build, which is why
     * the scope is the run rather than the repository.
     */
    expect(await readMetadata(created.otherRunId, 'version')).toBeNull()
  }, 120_000)

  test('a key nobody has set reads as nothing, not as an error', async () => {
    if (!available)
      return

    // An ordinary answer a script branches on, rather than something it has to
    // catch.
    expect(await readMetadata(created.runId, 'never-set')).toBeNull()
  }, 120_000)
})

describe('two jobs writing the same key', () => {
  test('the second is refused, and told what is actually there', async () => {
    if (!available)
      return

    const first = await readMetadata(created.runId, 'version')

    // Both jobs read version 1 and both try to write against it. The second one
    // has to lose, and has to be told - a lost write is a build quietly missing
    // something.
    const winner = await writeMetadata({
      runId: created.runId,
      key: 'version',
      value: '1.4.3',
      expectedVersion: first!.version,
    })

    const loser = await writeMetadata({
      runId: created.runId,
      key: 'version',
      value: '1.4.4',
      expectedVersion: first!.version,
    })

    expect(winner.ok).toBe(true)
    expect(loser.ok).toBe(false)
    expect(loser.status).toBe(409)

    // The value that is actually there comes back with the refusal, so the job
    // can merge and try again rather than read, guess and race a second time.
    expect(loser.current?.value).toBe('1.4.3')
    expect(loser.current?.version).toBe(winner.entry!.version)
  }, 120_000)

  test('`if_version: 0` means "only if nobody has set this"', async () => {
    if (!available)
      return

    const claim = await writeMetadata({ runId: created.runId, key: 'owner', value: 'job-a', expectedVersion: 0 })
    const second = await writeMetadata({ runId: created.runId, key: 'owner', value: 'job-b', expectedVersion: 0 })

    // A lock, in one write: whichever job gets there first owns the key, and
    // the other one knows it did not.
    expect(claim.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(second.current?.value).toBe('job-a')
  }, 120_000)

  test('and an unconditional write still wins, because that is what it asked for', async () => {
    if (!available)
      return

    // A job that owns a key nobody else touches should not have to read it
    // first. The compare is opt-in.
    const written = await writeMetadata({ runId: created.runId, key: 'version', value: '2.0.0' })

    expect(written.ok).toBe(true)
    expect((await readMetadata(created.runId, 'version'))?.value).toBe('2.0.0')
  }, 120_000)
})

describe('what is refused outright', () => {
  test('a value too large to be a value', async () => {
    if (!available)
      return

    /*
     * Named rather than truncated: a version number silently cut in half is a
     * deploy that ships the wrong thing. Anything this size is a file, and a
     * file is an artifact - which has content addressing, retention and a
     * download URL, none of which a key-value pair should grow.
     */
    const huge = await writeMetadata({ runId: created.runId, key: 'blob', value: 'x'.repeat(20_000) })

    expect(huge.ok).toBe(false)
    expect(huge.status).toBe(413)
    expect(String(huge.error)).toContain('artifact')
  }, 120_000)

  test('and a key with no name', async () => {
    if (!available)
      return

    expect((await writeMetadata({ runId: created.runId, key: '   ', value: 'x' })).status).toBe(422)
  }, 120_000)
})

describe('listing', () => {
  test('is everything this run has been told, in key order', async () => {
    if (!available)
      return

    const entries = await listMetadata(created.runId)

    expect(entries.map(one => one.key)).toEqual([...entries.map(one => one.key)].sort())
    expect(entries.find(one => one.key === 'version')?.value).toBe('2.0.0')
  }, 120_000)
})
