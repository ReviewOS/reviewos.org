import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { cacheStdout, cacheWhileStreaming } from '../../app/Actions/Git/stream'

test('a cache that stops consuming cannot retain the whole client download', async () => {
  let produced = 0; let rejected = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const chunk = new Uint8Array(1024)
  const source = new ReadableStream<Uint8Array>({ pull(controller) { if (produced++ === 100) controller.close(); else controller.enqueue(chunk) } })
  const result = cacheWhileStreaming(source, async body => {
    const reader = body.getReader(); await gate
    try { while (!(await reader.read()).done) {} } catch { rejected = true }
  }, { maxBufferedBytes: 2048 })
  expect((await new Response(result).arrayBuffer()).byteLength).toBe(100 * chunk.length)
  release(); await Bun.sleep(10)
  expect(rejected).toBe(true)
})

test('a healthy cache receives exact bytes while a cancelled client stops both branches', async () => {
  const cached: number[] = []
  const input = new Response(new Uint8Array([0, 255, 1, 254])).body!
  let done!: () => void; const stored = new Promise<void>(resolve => { done = resolve })
  const result = cacheWhileStreaming(input, async body => { for await (const chunk of body) cached.push(...chunk); done() })
  expect([...new Uint8Array(await new Response(result).arrayBuffer())]).toEqual([0, 255, 1, 254]); await stored
  expect(cached).toEqual([0, 255, 1, 254])
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const stream = cacheWhileStreaming(source, async body => { try { for await (const chunk of body) { void chunk } } catch {} })
  await stream.cancel(); expect(cancelled).toBe(true)
})


test('a child that exits unsuccessfully cannot publish a complete cached response', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('truncated'); process.exit(2)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  let accepted = false; let finish!: () => void
  const stored = new Promise<void>(resolve => { finish = resolve })
  const stream = cacheStdout(child, async body => { try { await new Response(body).arrayBuffer(); accepted = true } catch {} finally { finish() } })
  await new Response(stream).arrayBuffer(); await stored
  expect(accepted).toBe(false)
})
