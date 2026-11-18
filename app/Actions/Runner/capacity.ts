import { execFileSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { availableParallelism, loadavg, platform, tmpdir } from 'node:os'

export interface RunnerCapacityOptions {
  workspaceRoot?: string
  workspaceTemporaryRoot?: string
  /** MiB that must be available before claiming, including checkout/build growth. */
  minimumFreeDiskMb?: number
  /** Maximum one-minute host load per available logical CPU; zero disables it. */
  maximumLoadPerCpu?: number
}

export interface RunnerCapacity {
  acceptWork: boolean
  reason: string
}

// Foundation includes storage macOS can reclaim for an explicitly requested
// operation. statfs alone excludes it and can hold an APFS build host forever.
// The standard system interpreter avoids requiring Xcode or a helper install.
const macosCapacityScript = `function run(argv) {
  ObjC.import('Foundation');
  const result = Ref();
  const error = Ref();
  const url = $.NSURL.fileURLWithPath(argv[0]);
  if (!url.getResourceValueForKeyError(result, $.NSURLVolumeAvailableCapacityForImportantUsageKey, error))
    throw Error('Cannot read volume capacity');
  const value = ObjC.unwrap(result[0]);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw Error('Invalid volume capacity');
  return String(value);
}`

function macosAvailableCapacity(path: string): bigint | undefined {
  try {
    const output = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macosCapacityScript, '--', path], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (/^\d+$/.test(output))
      return BigInt(output)
  }
  catch { /* An unavailable OS measurement falls back to physical capacity. */ }
}

function hostLoadCapacity(options: RunnerCapacityOptions): RunnerCapacity {
  const configured = options.maximumLoadPerCpu ?? process.env.REVIEWOS_RUNNER_MAX_LOAD_PER_CPU ?? 0
  const maximum = typeof configured === 'number' ? configured : Number(configured)
  if ((typeof configured === 'string' && !configured.trim()) || !Number.isFinite(maximum) || maximum < 0)
    return { acceptWork: false, reason: 'The maximum host load setting must be a nonnegative finite number per CPU' }
  if (maximum === 0)
    return { acceptWork: true, reason: '' }

  try {
    // Windows reports zero load averages rather than a host measurement.
    if (platform() === 'win32')
      return { acceptWork: false, reason: 'Cannot verify host load on this platform' }
    const cpus = availableParallelism()
    const load = loadavg()[0]
    if (!Number.isSafeInteger(cpus) || cpus <= 0 || typeof load !== 'number' || !Number.isFinite(load) || load < 0)
      return { acceptWork: false, reason: 'Cannot verify host load and available CPU capacity' }
    if (load / cpus > maximum)
      return { acceptWork: false, reason: `Host load is too high: ${load.toFixed(2)} on ${cpus} CPUs, maximum ${maximum} per CPU` }
  }
  catch {
    return { acceptWork: false, reason: 'Cannot verify host load and available CPU capacity' }
  }
  return { acceptWork: true, reason: '' }
}

/** Operator policy, outside a job's environment. Invalid explicit policy refuses work. */
export function runnerCapacity(options: RunnerCapacityOptions): RunnerCapacity {
  const configured = options.minimumFreeDiskMb ?? process.env.REVIEWOS_RUNNER_MIN_FREE_DISK_MB ?? 0
  const minimumMb = typeof configured === 'number' ? configured : Number(configured)
  if ((typeof configured === 'string' && !configured.trim()) || !Number.isSafeInteger(minimumMb)
    || minimumMb < 0 || !Number.isSafeInteger(minimumMb * 1024 * 1024)) {
    return { acceptWork: false, reason: 'The minimum free disk setting must be a nonnegative whole number of MiB' }
  }
  const host = hostLoadCapacity(options)
  if (!host.acceptWork)
    return host
  if (minimumMb === 0)
    return { acceptWork: true, reason: '' }

  // Native tools may use the process temporary filesystem as well as the
  // checkout. An external workspace must not hide a full host temp volume.
  const paths = new Set([options.workspaceRoot ?? options.workspaceTemporaryRoot ?? tmpdir(), tmpdir()])
  for (const path of paths) {
    try {
      // bavail excludes blocks reserved for other users.
      const space = statfsSync(path, { bigint: true })
      let available = space.bavail * space.bsize
      const minimum = BigInt(minimumMb) * 1024n * 1024n
      if (space.bsize <= 0n)
        return { acceptWork: false, reason: `Cannot verify available workspace disk space at ${path}` }
      if (available < minimum && platform() === 'darwin') {
        const important = macosAvailableCapacity(path)
        if (important !== undefined && important > available)
          available = important
      }
      if (available < minimum)
        return { acceptWork: false, reason: `Insufficient workspace disk space at ${path}: ${available / 1048576n} MiB available, ${minimumMb} MiB required` }
    }
    catch {
      return { acceptWork: false, reason: `Cannot verify available workspace disk space at ${path}` }
    }
  }
  return { acceptWork: true, reason: '' }
}
