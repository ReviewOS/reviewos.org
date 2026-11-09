import { expect, test } from 'bun:test'
import { watchJobLog, watchRun } from '../../resources/functions/runlive'

test('a stopped run follower ignores an in-flight response and bypasses caches', async () => {
  const original = globalThis.fetch
  let release: (value: Response) => void = () => {}
  let cache: RequestCache | undefined
  let updates = 0
  globalThis.fetch = ((url: any, init: any) => {
    cache = init?.cache
    return new Promise<Response>((resolve) => { release = resolve })
  }) as typeof fetch
  try {
    const follower = watchRun({ owner: 'one', repository: 'two', number: 1, onRun: () => updates++ })
    follower.stop()
    release(Response.json({ workflow_run: { number: 1, state: 'succeeded', jobs: [] } }))
    await Bun.sleep(10)
    expect(cache).toBe('no-store')
    expect(updates).toBe(0)
  }
  finally { globalThis.fetch = original }
})

test('a failed read reports a retry, never a completed run', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch
  const states: string[] = []
  let finished = false
  const follower = watchRun({ owner: 'one', repository: 'two', number: 1, onRun: () => {}, onConnection: state => states.push(state), onFinished: () => { finished = true } })
  try {
    await Bun.sleep(10)
    expect(states).toEqual(['connecting', 'retrying'])
    expect(finished).toBe(false)
  }
  finally { follower.stop(); globalThis.fetch = original }
})

test('a log follower does not replay already-seen chunk sequences', async () => {
  const original = globalThis.fetch
  let reads = 0
  const outputs: string[] = []
  globalThis.fetch = (async () => {
    reads++
    return Response.json({ chunks: [{ sequence: 1, content: 'old' }, { sequence: 2, content: 'new' }], cursor: 2, state: reads === 1 ? 'running' : 'succeeded' })
  }) as typeof fetch
  const follower = watchJobLog({ owner: 'one', repository: 'two', job: 1, after: 1, onOutput: text => outputs.push(text) })
  try {
    await Bun.sleep(2200)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(outputs).toEqual(['new'])
  }
  finally { follower.stop(); globalThis.fetch = original }
}, 5000)
