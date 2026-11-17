import { spawnOwnedProcess } from '@stacksjs/cli/owned-process'

export interface TestBudgetOptions {
  command: string[]
  cwd?: string
  timeoutMs?: number
  stopGraceMs?: number
  outputDrainMs?: number
  write: (chunk: Uint8Array) => void | Promise<void>
}

/** Keep the existing suite deadline inside the job so a hang retains its log. */
export async function testWithBudget(options: TestBudgetOptions): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 22 * 60_000
  const outputDrainMs = options.outputDrainMs ?? 2000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(outputDrainMs) || outputDrainMs <= 0)
    throw new RangeError('Test budgets must be positive finite milliseconds')
  const child = spawnOwnedProcess(options.command, {
    cwd: options.cwd, stdout: 'pipe', stderr: 'pipe', stopGraceMs: options.stopGraceMs ?? 30_000,
  })
  const readers = [child.stdout!, child.stderr!].map(stream => stream.getReader())
  const copying = Promise.allSettled(readers.map(async (reader) => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      await options.write(next.value)
    }
  }))
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopping = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      void child.stop().catch(reject)
    }, timeoutMs)
  })
  let exit: Awaited<typeof child.exited>
  try { exit = await Promise.race([child.exited, stopping]) }
  catch (error) {
    for (const reader of readers) void reader.cancel().catch(() => {})
    throw error
  }
  finally { clearTimeout(timer) }
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const copied = await Promise.race([
    copying,
    new Promise<null>(resolve => { drainTimer = setTimeout(() => resolve(null), outputDrainMs) }),
  ])
  clearTimeout(drainTimer)
  if (copied === null) {
    // An escaped descendant must never hold the Actions runner's output pipe.
    // The supervised command only inherits our private pipes, not Actions'.
    for (const reader of readers) void reader.cancel().catch(() => {})
  }
  if (timedOut) {
    await options.write(new TextEncoder().encode(`\n::error::The test suite exceeded its ${timeoutMs}ms budget and was stopped. The original output above is retained; no later gate passed.\n`))
    return 124
  }
  if (copied === null || copied.some(result => result.status === 'rejected')) {
    await options.write(new TextEncoder().encode('\n::error::Test output did not close cleanly after the command exited.\n'))
    return 1
  }
  return exit.code === 0 && exit.signal === null ? 0 : exit.code || 1
}

if (import.meta.main) {
  process.exitCode = await testWithBudget({
    command: [process.execPath, 'run', 'test'],
    write: chunk => new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, error => error ? reject(error) : resolve())
    }),
  })
}
