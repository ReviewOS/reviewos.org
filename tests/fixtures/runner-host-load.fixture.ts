// Keep the OS probe stand-in in a child process; other suites see the real host.
import { mock } from 'bun:test'
import * as nativeOs from 'node:os'

const actualOs = { ...nativeOs }
let oneMinute = 8
let cpus = 4
let hostPlatform = 'linux'
let unreadable = false
mock.module('node:os', () => ({
  ...actualOs,
  availableParallelism: () => cpus,
  loadavg: () => {
    if (unreadable) throw new Error('host metrics unavailable')
    return [oneMinute, oneMinute, oneMinute]
  },
  platform: () => hostPlatform,
}))

const { runOnce, takeStopRequest } = await import('../../app/Actions/Runner/localExecutor')
const { runnerCapacity } = await import('../../app/Actions/Runner/capacity')
const polls: unknown[] = []
const messages: string[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  polls.push(await request.json())
  return Response.json({ job: null, runner_id: 5, ...(polls.length === 1 ? { stop: 'graceful' } : {}) })
} })
try {
  process.env.REVIEWOS_RUNNER_MAX_LOAD_PER_CPU = '1.5'
  const options = {
    baseUrl: `http://127.0.0.1:${server.port}`, token: 'host-capacity-fixture',
    minimumFreeDiskMb: 0,
    say: (line: string) => messages.push(line),
  }
  await runOnce(options)
  const stop = takeStopRequest()
  oneMinute = 4
  await runOnce(options)
  const decisions: Record<string, boolean> = {}
  const measure = () => runnerCapacity({ minimumFreeDiskMb: 0, maximumLoadPerCpu: 1.5 }).acceptWork
  oneMinute = 6
  decisions.atLimit = measure()
  oneMinute = Number.NaN
  decisions.invalidLoad = measure()
  oneMinute = 4
  cpus = 0
  decisions.invalidCpus = measure()
  cpus = 4
  unreadable = true
  decisions.unreadable = measure()
  unreadable = false
  hostPlatform = 'win32'
  decisions.unsupported = measure()
  decisions.disabled = runnerCapacity({ minimumFreeDiskMb: 0, maximumLoadPerCpu: 0 }).acceptWork
  hostPlatform = 'linux'
  for (const value of ['', 'invalid', '-1', 'Infinity']) {
    process.env.REVIEWOS_RUNNER_MAX_LOAD_PER_CPU = value
    decisions[`invalidPolicy:${value}`] = runnerCapacity({ minimumFreeDiskMb: 0 }).acceptWork
  }
  delete process.env.REVIEWOS_RUNNER_MAX_LOAD_PER_CPU
  unreadable = true
  decisions.defaultDisabled = runnerCapacity({ minimumFreeDiskMb: 0 }).acceptWork
  console.log(JSON.stringify({ polls, stop, messages, decisions }))
}
finally { server.stop(true) }
