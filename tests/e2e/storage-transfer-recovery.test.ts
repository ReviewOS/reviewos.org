import { afterAll, beforeAll, expect, test } from 'bun:test'
import { db } from '@stacksjs/database'
import { cancelTransfer, claimTransfer, restartTransfer, saveTransfer, startTransfer } from '../../app/Actions/Storage/operations'

const originalBucket = process.env.BLOB_MIGRATION_S3_BUCKET
const ids: number[] = []
let available = false
beforeAll(async () => {
  process.env.BLOB_MIGRATION_S3_BUCKET = 'disposable-transfer-recovery'
  try { await db.selectFrom('operations').select('id').limit(1).execute(); available = true }
  catch (error) { console.warn(`[storage-transfer-recovery] skipping: ${error instanceof Error ? error.message : String(error)}`) }
})
afterAll(async () => {
  if (ids.length) await db.deleteFrom('operations').where('id', 'in', ids).execute()
  if (originalBucket === undefined) delete process.env.BLOB_MIGRATION_S3_BUCKET
  else process.env.BLOB_MIGRATION_S3_BUCKET = originalBucket
})

test.skipIf(process.platform !== 'linux')('an exited worker resumes from its durable prefix without stealing a live lease', async () => {
  if (!available) return
  const id = await startTransfer('storage.blobs'); ids.push(id)
  const module = new URL('../../app/Actions/Storage/operations.ts', import.meta.url).pathname
  const child = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', '-e', `
    import { claimTransfer, saveTransfer } from ${JSON.stringify(module)};
    const first = await claimTransfer('storage.blobs', ${id});
    Object.assign(first.progress, { cursor: 'artifacts/saved', verified: 3, bytes: 100 });
    await saveTransfer(first, false);
    const active = await claimTransfer('storage.blobs', ${id});
    console.log('__transfer_lease__' + JSON.stringify({ lease: active.lease }));
    await new Response(Bun.stdin).text();
    await (await import('@stacksjs/database')).resetDatabaseConnection();
  `], { env: process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(10000) })
  try {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder(); let output = ''; let record: RegExpMatchArray | null = null
    while (!record) {
      const next = await reader.read()
      if (next.done) throw new Error('The fixture exited before claiming its transfer')
      output += decoder.decode(next.value, { stream: true })
      record = output.match(/^__transfer_lease__(\{[^\n]+\})/m)
    }
    const active = JSON.parse(record[1]!)
    await db.updateTable('operations').set({ started_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() }).where('id', '=', id).execute()
    expect(await claimTransfer('storage.blobs', id)).toBeNull()
    await db.updateTable('operations').set({ started_at: active.lease }).where('id', '=', id).execute()
    child.stdin.end(); expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    reader.releaseLock()
    const resumed = await claimTransfer('storage.blobs', id)
    expect(resumed).not.toBeNull()
    expect(resumed!.progress.cursor).toBe('artifacts/saved')
    expect(resumed!.progress.verified).toBe(3)
    expect(resumed!.progress.bytes).toBe(100)
    await expect(saveTransfer({ ...resumed!, lease: active.lease }, false)).rejects.toThrow('lease changed')
    await saveTransfer(resumed!, true)
  }
  finally { child.kill(); await child.exited }
}, 15000)

test('checkpoint restart preserves the retired operation and is idempotent under concurrent requests', async () => {
  if (!available) return
  const id = await startTransfer('storage.repositories'); ids.push(id)
  const claim = await claimTransfer('storage.repositories', id)
  Object.assign(claim!.progress, { cursor: '42', verified: 41, bytes: 123456 })
  await saveTransfer(claim!, false)
  await expect(restartTransfer(id)).rejects.toThrow('Cancel')
  await cancelTransfer(id)
  const [one, two] = await Promise.all([restartTransfer(id), restartTransfer(id)])
  ids.push(one.id)
  expect(one).toEqual(two)
  expect(one.id).not.toBe(id)
  expect(await claimTransfer('storage.repositories', id)).toBeNull()
  const original: any = await db.selectFrom('operations').selectAll().where('id', '=', id).executeTakeFirst()
  const next: any = await db.selectFrom('operations').selectAll().where('id', '=', one.id).executeTakeFirst()
  expect(original.status).toBe('cancelled')
  expect(JSON.parse(original.result).successorOperationId).toBe(one.id)
  expect(JSON.parse(next.result)).toMatchObject({ cursor: '42', verified: 41, bytes: 123456, restartedFrom: id })
  process.env.BLOB_MIGRATION_S3_BUCKET = 'another-destination'
  try { await expect(restartTransfer(id)).rejects.toThrow('destination changed') }
  finally { process.env.BLOB_MIGRATION_S3_BUCKET = 'disposable-transfer-recovery' }
})
