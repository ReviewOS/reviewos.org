import assert from 'node:assert/strict'
import { listProcesses, pruneGroup, recordGroup, survivors, trackingIdFor } from '../../app/Actions/Runner/orphans'

const id = trackingIdFor('metadata-only')
const group = 1_000_000_000
const absent = [{ pid: group, pgid: group, name: 'not-a-real-process', environment: null }]
recordGroup(id, group)
assert.equal(survivors(id, absent).length, 1)
// Forgetting a group needs only the real PID/group table, even when an
// external process-environment reader is unavailable.
pruneGroup(id, group)
assert.equal(survivors(id, absent).length, 0)
const metadata = listProcesses({ environment: false })
assert(metadata.length > 0 && metadata.every(row => row.environment === null))
let fullInspectionBlocked = false
try {
  const full = listProcesses()
  assert(full.some(row => row.pid === process.pid && row.environment !== null))
}
catch (error) {
  assert.equal(process.platform, 'darwin')
  assert.match(String(error), /could not inspect process environments safely/)
  fullInspectionBlocked = true
}
assert.equal(fullInspectionBlocked, process.platform === 'darwin' && process.argv[2] !== 'transient')
console.log(JSON.stringify({ groupForgotten: true, metadataOnly: true, fullInspectionBlocked }))
