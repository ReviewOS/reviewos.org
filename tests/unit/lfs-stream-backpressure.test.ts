import { expect, test } from 'bun:test'
import { blobObjectStore } from '../../app/Actions/Git/lfs'
import { useBlobStore } from '../../app/Actions/Git/blobs'

test('LFS pulls only what a download consumes and cancels upstream', async () => {
  let produced = 0; let cancelled = false
  const source = new ReadableStream<Uint8Array>({ pull(controller) { produced++; controller.enqueue(new Uint8Array(1024)) }, cancel() { cancelled = true } })
  useBlobStore({ get: async () => source } as any)
  try {
    const reader = blobObjectStore('fixture', 'repository').stream('a'.repeat(64)).getReader()
    await Bun.sleep(10)
    expect(produced).toBeLessThanOrEqual(3)
    expect((await reader.read()).value?.length).toBe(1024)
    await reader.cancel(); expect(cancelled).toBe(true)
  } finally { useBlobStore(null) }
})

test('LFS provider errors fail the stream instead of pretending it is empty', async () => {
  useBlobStore({ get: async () => { throw new Error('provider unavailable') } } as any)
  try { await expect(new Response(blobObjectStore('fixture', 'repository').stream('a'.repeat(64))).arrayBuffer()).rejects.toThrow('provider unavailable') }
  finally { useBlobStore(null) }
})
