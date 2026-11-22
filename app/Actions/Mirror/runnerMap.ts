/**
 * A CI mirror's hosted runner labels, translated onto this instance's runners.
 *
 * A workflow written for GitHub names GitHub's machines: `ubuntu-latest`,
 * `macos-latest`, `windows-latest`, `ubuntu-24.04-arm`. A mirror that runs its
 * upstream's workflows here (`run_workflows`) inherits those labels, and with
 * none of this instance's runners answering to them, every job sat queued
 * until its timeout and the upstream commit showed a status that never left
 * `pending`. The upstream cannot fix that from its side - GitHub refuses a
 * file carrying this forge's `reviewos:` key, and renaming the labels breaks
 * the workflow where it came from.
 *
 * So the operator says it once, on the mirror (`runners:` in `mirrors.yml`):
 *
 *     runners:
 *       ubuntu-latest: [self-hosted, linux-x64]
 *       windows-latest: false
 *
 * A label mapped to a list is replaced by that list. A label mapped to `false`
 * is one no machine here runs, and a job asking for it is **skipped with the
 * reason** rather than queued: the job still runs where the workflow came from,
 * and a mirror's run that waits forever for a machine nobody owns is a run that
 * never reports anything. A label the map does not mention passes through
 * untouched, so `self-hosted` and a repository's own labels keep meaning what
 * they meant.
 *
 * A job-level `container:` is the other half of the same question. It names an
 * environment, an image every step runs inside, and this instance does not run
 * job containers (see the conformance table). On a translated mirror such a job
 * is skipped with the reason too, rather than handed to a host whose
 * environment is not the one its steps were written for.
 */

/** The label, and what stands in for it here: labels, or null for "nothing here runs it". */
export type RunnerMap = Map<string, string[] | null>

/** What dispatch does with one job's `runs-on`. */
export interface Translation {
  run: boolean
  /** Why it is skipped, in a sentence the run page shows. Empty when it runs. */
  reason: string
  runsOn: string[]
}

const LABEL = /^[\w.:-]{1,100}$/

/** The map as `repository_mirrors.runner_labels` stores it: one `label=a,b` line each. */
export function readRunnerMap(stored: string | null | undefined): RunnerMap {
  const map: RunnerMap = new Map()

  for (const line of String(stored ?? '').split('\n')) {
    const at = line.indexOf('=')
    if (at < 1)
      continue

    const label = line.slice(0, at).trim().toLowerCase()
    if (!LABEL.test(label))
      continue

    const targets = line.slice(at + 1).split(',').map(one => one.trim()).filter(one => LABEL.test(one))

    map.set(label, targets.length > 0 ? targets : null)
  }

  return map
}

/** The stored form, or null for an empty map so the column stays empty. */
export function storeRunnerMap(map: RunnerMap): string | null {
  const lines = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, targets]) => `${label}=${(targets ?? []).join(',')}`)

  return lines.length > 0 ? lines.join('\n') : null
}

/**
 * The map a `mirrors.yml` line declares, or null when it has no opinion.
 *
 * Each value is a list of labels, one comma-separated string, or `false` (or
 * an empty list) for "no machine here runs this". Anything else is dropped
 * rather than guessed at, and a label that is not shaped like one is dropped
 * with it.
 */
export function declaredRunnerMap(value: unknown): RunnerMap | null {
  if (value === undefined || value === null)
    return null

  const map: RunnerMap = new Map()
  if (typeof value !== 'object' || Array.isArray(value))
    return map

  for (const [raw, target] of Object.entries(value as Record<string, unknown>)) {
    const label = String(raw).trim().toLowerCase()
    if (!LABEL.test(label))
      continue

    if (target === false) {
      map.set(label, null)
      continue
    }

    const targets = (Array.isArray(target) ? target.map(String) : typeof target === 'string' ? target.split(',') : [])
      .map(one => one.trim())
      .filter(one => LABEL.test(one))

    if (Array.isArray(target) || typeof target === 'string')
      map.set(label, targets.length > 0 ? targets : null)
  }

  return map
}

/**
 * Translate one job's labels.
 *
 * An empty map changes nothing - not even the container rule, which belongs to
 * a mirror whose operator has said where its upstream's jobs run. Labels are
 * matched without regard to case, as the claim matches them.
 */
export function translateRunsOn(
  runsOn: readonly string[],
  map: RunnerMap,
  container: string | null = null,
): Translation {
  const labels = [...runsOn]

  if (map.size === 0)
    return { run: true, reason: '', runsOn: labels }

  const missing = labels.filter(label => map.has(label.toLowerCase()) && map.get(label.toLowerCase()) === null)
  if (missing.length > 0) {
    return {
      run: false,
      reason: `No runner on this instance stands in for ${missing.map(label => `\`${label}\``).join(', ')} (the mirror's \`runners:\`), so this job runs only upstream.`,
      runsOn: labels,
    }
  }

  if (container) {
    return {
      run: false,
      reason: `This instance does not run job containers (\`container: ${container}\`), so this job runs only upstream.`,
      runsOn: labels,
    }
  }

  const translated: string[] = []
  for (const label of labels) {
    for (const one of map.get(label.toLowerCase()) ?? [label]) {
      if (!translated.some(known => known.toLowerCase() === one.toLowerCase()))
        translated.push(one)
    }
  }

  return { run: true, reason: '', runsOn: translated }
}

/**
 * A CI mirror's workflow allowlist (`workflows:` in `mirrors.yml`), stored as
 * one path per line: sorted, without duplicates, or null for "all of them".
 */
export function storeWorkflowPaths(paths: readonly string[] | null | undefined): string | null {
  const kept = [...new Set((paths ?? []).map(path => String(path).trim()).filter(path => /^[\w./-]{1,300}$/.test(path)))].sort()

  return kept.length > 0 ? kept.join('\n') : null
}

/**
 * Whether a workflow at `path` is one the allowlist starts. An empty list starts
 * every workflow; a line matches the full path or the file name alone, so
 * `ci.yml` and `.github/workflows/ci.yml` say the same thing.
 */
export function workflowAllowed(stored: string | null | undefined, path: string): boolean {
  const lines = String(stored ?? '').split('\n').map(line => line.trim()).filter(Boolean)

  if (lines.length === 0)
    return true

  const name = String(path).split('/').pop() ?? ''

  return lines.some(line => line === path || line === name)
}

