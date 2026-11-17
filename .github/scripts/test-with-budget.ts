import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnOwnedProcess } from '@stacksjs/cli/owned-process'

export interface TestBudgetOptions {
  command: string[]
  cwd?: string
  timeoutMs?: number
  stopGraceMs?: number
  outputDrainMs?: number
  /** How often to record the machine's state. Zero or less records nothing. */
  sampleMs?: number
  /** Where that state comes from. Injected by the tests, which have no /proc. */
  sample?: () => string | null
  write: (chunk: Uint8Array) => void | Promise<void>
}

const KIB_PER_MIB = 1024
const BYTES_PER_MIB = 1024 * 1024

/**
 * The machine, as one line, so a death the job did not cause is still legible.
 *
 * ## Why this is here
 *
 * Twice in one run, `test (mysql)` died with no test having failed. Once the
 * whole step was signalled at 13m03s and exited 143, with every following
 * step - including the `if: always()` artifact upload - skipped. Once the
 * runner stopped answering altogether around 11m52s, and GitHub force-cancelled
 * at the 30-minute ceiling, which loses the log blob to BlobNotFound.
 *
 * What rules out the obvious explanations:
 *
 * - Not a failing test. The retained log has no `(fail)` line in 569 files.
 * - Not this job's budget. The supervisor's own deadline is 22 minutes and the
 *   outer `timeout` is 23; both deaths were earlier than either.
 * - Not the suite running out of memory. The supervisor returns 1 when its
 *   child dies on a signal and prints a closing line either way. There was no
 *   closing line, so the supervisor itself was signalled, and it is a byte
 *   relay that allocates nothing.
 * - Not the dialect. A 35-minute cancellation has hit `test (postgres)` too.
 * - Not the image. Passing and failing jobs all ran ubuntu26/20261111.196.
 *
 * What is left is the machine: memory, swap or disk giving out near the tail of
 * a 14-minute suite, taking the runner agent with it. Nothing in the job
 * records any of that, which is the only reason the question is still open - so
 * record it. A line every fifteen seconds costs about sixty lines in a log that
 * runs to twelve thousand, and the sample that matters is the last one before
 * the job stops, which is exactly the one a file-based artifact never gets to
 * upload.
 *
 * This samples from inside the supervisor on purpose. A background `free -s`
 * would be a descendant holding the step's stdout, which is the failure the
 * supervisor exists to prevent; an interval in this process cannot outlive it.
 */
export function machineSample(at: Date = new Date(), proc = '/proc', diskPath = '.'): string | null {
  try {
    const fields = new Map<string, number>()
    for (const line of readFileSync(join(proc, 'meminfo'), 'utf8').split('\n')) {
      const [name, amount] = line.split(':')
      if (name && amount)
        fields.set(name, Number.parseInt(amount.trim(), 10))
    }
    const mib = (name: string) => Math.round((fields.get(name) ?? 0) / KIB_PER_MIB)
    const load = readFileSync(join(proc, 'loadavg'), 'utf8').trim().split(/\s+/).slice(0, 3).join(' ')
    const disk = statfsSync(diskPath)
    const diskFree = Math.round((Number(disk.bsize) * Number(disk.bavail)) / BYTES_PER_MIB)
    return `[machine ${at.toISOString()}] memory ${mib('MemAvailable')}/${mib('MemTotal')}MiB available, swap ${mib('SwapFree')}/${mib('SwapTotal')}MiB free, disk ${diskFree}MiB free, load ${load}`
  }
  catch {
    // No /proc, no statfs, a kernel that words meminfo differently: the sample
    // is a diagnostic, and a diagnostic that can fail a job is worse than none.
    return null
  }
}

/** Keep the existing suite deadline inside the job so a hang retains its log. */
export async function testWithBudget(options: TestBudgetOptions): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 22 * 60_000
  const outputDrainMs = options.outputDrainMs ?? 2000
  const sampleMs = options.sampleMs ?? 15_000
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
  // Take the machine's state now as well as on the interval: a job that dies in
  // its first few seconds should still say what it died on.
  const sample = options.sample ?? (() => (existsSync('/proc/meminfo') ? machineSample() : null))
  const record = () => {
    const line = sample()
    if (line)
      void options.write(new TextEncoder().encode(`${line}\n`))
  }
  let sampler: ReturnType<typeof setInterval> | undefined
  if (Number.isFinite(sampleMs) && sampleMs > 0) {
    record()
    sampler = setInterval(record, sampleMs)
  }
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
  finally { clearTimeout(timer); clearInterval(sampler) }
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
  console.log(`CI suite supervisor entered at ${new Date().toISOString()}`)
  process.exitCode = await testWithBudget({
    command: [process.execPath, 'run', 'test'],
    write: chunk => new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, error => error ? reject(error) : resolve())
    }),
  })
  console.log(`CI suite supervisor finished with exit ${process.exitCode} at ${new Date().toISOString()}`)
}
