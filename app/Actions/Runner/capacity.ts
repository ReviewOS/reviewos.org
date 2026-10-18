import { statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'

export interface RunnerCapacityOptions {
  workspaceRoot?: string
  workspaceTemporaryRoot?: string
  /** MiB that must be available before claiming, including checkout/build growth. */
  minimumFreeDiskMb?: number
}

export interface RunnerCapacity {
  acceptWork: boolean
  reason: string
}

/** Operator policy, outside a job's environment. Invalid explicit policy refuses work. */
export function runnerCapacity(options: RunnerCapacityOptions): RunnerCapacity {
  const configured = options.minimumFreeDiskMb ?? process.env.REVIEWOS_RUNNER_MIN_FREE_DISK_MB ?? 0
  const minimumMb = typeof configured === 'number' ? configured : Number(configured)
  if ((typeof configured === 'string' && !configured.trim()) || !Number.isSafeInteger(minimumMb)
    || minimumMb < 0 || !Number.isSafeInteger(minimumMb * 1024 * 1024)) {
    return { acceptWork: false, reason: 'The minimum free disk setting must be a nonnegative whole number of MiB' }
  }
  if (minimumMb === 0)
    return { acceptWork: true, reason: '' }

  // Native tools may use the process temporary filesystem as well as the
  // checkout. An external workspace must not hide a full host temp volume.
  const paths = new Set([options.workspaceRoot ?? options.workspaceTemporaryRoot ?? tmpdir(), tmpdir()])
  for (const path of paths) {
    try {
      // bavail excludes blocks reserved for other users.
      const space = statfsSync(path, { bigint: true })
      const available = space.bavail * space.bsize
      const minimum = BigInt(minimumMb) * 1024n * 1024n
      if (space.bsize <= 0n)
        return { acceptWork: false, reason: `Cannot verify available workspace disk space at ${path}` }
      if (available < minimum)
        return { acceptWork: false, reason: `Insufficient workspace disk space at ${path}: ${available / 1048576n} MiB available, ${minimumMb} MiB required` }
    }
    catch {
      return { acceptWork: false, reason: `Cannot verify available workspace disk space at ${path}` }
    }
  }
  return { acceptWork: true, reason: '' }
}
