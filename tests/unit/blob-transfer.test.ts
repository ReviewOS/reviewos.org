import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalBlobStore } from '../../app/Actions/Git/blobs'
import { blobDigest, copyVerifiedBlob, copyVerifiedBlobs } from '../../app/Actions/Storage/transfer'

test('a verified transfer preserves every source, skips identical bytes and refuses same-size conflicts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-transfer-'))
  try {
    const source = new LocalBlobStore(join(root, 'source')); const target = new LocalBlobStore(join(root, 'target'))
    await source.put('artifacts/one', new Uint8Array([0, 255, 1, 254]))
    expect(await copyVerifiedBlob(source, target, 'artifacts/one')).toEqual({ bytes: 4, copied: true })
    expect(await blobDigest(source, 'artifacts/one')).toEqual(await blobDigest(target, 'artifacts/one'))
    expect(await copyVerifiedBlob(source, target, 'artifacts/one')).toEqual({ bytes: 4, copied: false })
    await target.put('artifacts/one', new Uint8Array([255, 0, 254, 1]))
    await expect(copyVerifiedBlob(source, target, 'artifacts/one')).rejects.toThrow('Destination conflict')
    expect((await source.stat('artifacts/one'))?.size).toBe(4)
    expect(new Uint8Array(await new Response(await target.get('artifacts/one')).arrayBuffer())).toEqual(new Uint8Array([255, 0, 254, 1]))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a provider that acknowledges corrupt bytes never produces a successful migration checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-transfer-'))
  try {
    const source = new LocalBlobStore(join(root, 'source')); const target = new LocalBlobStore(join(root, 'target'))
    await source.put('wal/1/bundle', 'durable user bytes')
    target.put = async key => ({ key, size: 18, modifiedAtMs: Date.now() })
    await expect(copyVerifiedBlob(source, target, 'wal/1/bundle')).rejects.toThrow('Missing transfer object')
    expect(await source.get('wal/1/bundle')).not.toBeNull()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verified receipts skip unchanged bodies and reject a changed remote identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-transfer-proof-'))
  try {
    const source = new LocalBlobStore(join(root, 'source')); const target = new LocalBlobStore(join(root, 'target'))
    const key = 'artifacts/one'; const receiptScope = 'a'.repeat(64)
    await source.put(key, 'preserved bytes')
    const originalStat = target.stat.bind(target)
    target.stat = async name => { const found = await originalStat(name); return found ? { ...found, etag: found.fingerprint } : null }
    const originalGet = target.get.bind(target); let fullReads = 0
    target.get = async name => { if (name === key) fullReads++; return originalGet(name) }
    await copyVerifiedBlob(source, target, key, { receiptScope })
    fullReads = 0
    expect(await copyVerifiedBlob(source, target, key, { receiptScope })).toEqual({ bytes: 15, copied: false })
    expect(fullReads).toBe(0)
    await target.put(key, 'different bytes')
    await expect(copyVerifiedBlob(source, target, key, { receiptScope })).rejects.toThrow('Destination conflict')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('concurrent local writers retain complete independent temporary files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-atomic-blob-'))
  try {
    const store = new LocalBlobStore(root)
    await store.put('artifacts/one', 'previous')
    let releaseFirst!: () => void; let releaseSecond!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve }); const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    async function* first() { yield new TextEncoder().encode('first-'); await firstGate; yield new TextEncoder().encode('complete') }
    async function* second() { yield new TextEncoder().encode('second-'); await secondGate; yield new TextEncoder().encode('complete') }
    const one = store.put('artifacts/one', first()); const two = store.put('artifacts/one', second())
    await Bun.sleep(10)
    expect(await new Response(await store.get('artifacts/one')).text()).toBe('previous')
    releaseFirst(); await one; releaseSecond(); await two
    expect(await new Response(await store.get('artifacts/one')).text()).toBe('second-complete')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('bounded local pages preserve lexical order across file and directory names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-blob-pages-'))
  try {
    const store = new LocalBlobStore(root)
    const keys = ['foo/bar', 'foo.txt', 'foo/Z', 'foo/a', 'artifacts/ff/end', 'artifacts/aa/start']
    for (const key of keys) await store.put(key, key)
    const found: string[] = []; let cursor = ''
    for (;;) {
      const page = await store.page(cursor, 1)
      expect(page.entries.length).toBeLessThanOrEqual(1)
      for (const item of page.entries) { found.push(item.key); cursor = item.key }
      if (!page.more) break
    }
    expect(found).toEqual([...keys].sort())
    expect(new Set(found).size).toBe(keys.length)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('bounded parallel copies never checkpoint past an unverified key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-transfer-batch-'))
  try {
    const source = new LocalBlobStore(join(root, 'source')); const target = new LocalBlobStore(join(root, 'target'))
    const files = Array.from({ length: 8 }, (_, index) => ({ key: `fixture/file-${index}` }))
    for (const file of files) await source.put(file.key, file.key)
    const put = target.put.bind(target)
    let active = 0; let maximum = 0; let fail = true
    target.put = async (key, body) => {
      active++; maximum = Math.max(maximum, active)
      try { await Bun.sleep(5); if (fail && key.endsWith('-2')) throw new Error('provider unavailable'); return await put(key, body) }
      finally { active-- }
    }
    const checkpoint: string[] = []
    await expect(copyVerifiedBlobs(source, target, files, {}, key => checkpoint.push(key))).rejects.toThrow('provider unavailable')
    expect(checkpoint).toEqual(['fixture/file-0', 'fixture/file-1'])
    expect(active).toBe(0); expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(4)
    expect(await target.get('fixture/file-3')).not.toBeNull()
    fail = false
    await copyVerifiedBlobs(source, target, files.slice(2), {}, key => checkpoint.push(key))
    expect(checkpoint).toEqual(files.map(file => file.key))
    for (const file of files) expect(await blobDigest(target, file.key)).toEqual(await blobDigest(source, file.key))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
