// runOnce and SIGTERM, in a process of its own: a signal is process-wide.
//
// Runs one job whose step leaves a daemon in a session of its own (the way a
// setup step starts PostgreSQL) and then keeps running. The parent test sends
// this process SIGTERM once the daemon's pid is on disk.
import process from 'node:process'

const { runOnce } = await import('../../app/Actions/Runner/localExecutor')
const { awaitStop, stopInProgress } = await import('../../app/Actions/Runner/orphans')

const [baseUrl, workspaceRoot, ledgerRoot] = process.argv.slice(2)

await runOnce({ baseUrl: baseUrl!, token: 'stop-fixture', workspaceRoot, attemptLedgerRoot: ledgerRoot, tools: false, minimumFreeDiskMb: 0, maximumLoadPerCpu: 0, say: line => console.log(line) })

// The handler exits with the signal's status once the job is put away.
if (stopInProgress())
  await awaitStop()

// Only reached if the signal never arrived.
console.log('runOnce returned')
process.exit(0)
