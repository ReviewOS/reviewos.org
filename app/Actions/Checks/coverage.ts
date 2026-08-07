/**
 * Coverage, from a CI upload to a mark in the diff.
 *
 * The report changes the question a reviewer asks about a changed line from
 * "does this look right" to "what happens when this is wrong" - which is the
 * more useful question, and one only worth raising on lines the tests
 * genuinely never execute. So the rule everywhere here is honesty by
 * absence: no report, a corrupt row, a file the report does not mention -
 * all render nothing. A marker that defaults to "covered" would be the diff
 * lying about the one thing this exists to say.
 */

/**
 * Parse an lcov report into per-file line coverage.
 *
 * lcov because it is the lingua franca every coverage tool can emit. Only
 * three record types matter - `SF:` opens a file, `DA:<line>,<hits>` counts
 * one line, `end_of_record` closes - and everything else (function and
 * branch records, checksums) is deliberately skipped rather than validated:
 * the report is CI's word for it either way.
 */
export function parseLcov(text: string): Map<string, { covered: number[], uncovered: number[] }> {
  const files = new Map<string, { covered: number[], uncovered: number[] }>()

  let current: { covered: number[], uncovered: number[] } | null = null

  for (const raw of text.split('\n')) {
    const line = raw.trim()

    if (line.startsWith('SF:')) {
      const path = line.slice(3).trim().replace(/^\.\//, '')
      current = files.get(path) ?? { covered: [], uncovered: [] }
      files.set(path, current)
      continue
    }

    if (line === 'end_of_record') {
      current = null
      continue
    }

    if (current && line.startsWith('DA:')) {
      const [numberPart, hitsPart] = line.slice(3).split(',')
      const lineNumber = Number(numberPart)
      const hits = Number(hitsPart)

      if (!Number.isInteger(lineNumber) || lineNumber <= 0 || !Number.isFinite(hits))
        continue

      if (hits > 0)
        current.covered.push(lineNumber)
      else
        current.uncovered.push(lineNumber)
    }
  }

  return files
}

/**
 * The uncovered lines for every file of one commit, from storage.
 *
 * Keyed by commit rather than by pull request, so one report serves every
 * pull request whose head is that commit. A row that cannot be read renders
 * as no data, never as "covered".
 */
export async function loadCoverage(repositoryId: number, commitSha: string): Promise<Map<string, Set<number>>> {
  const uncoveredByPath = new Map<string, Set<number>>()

  if (!repositoryId || !/^[0-9a-f]{40}$/.test(commitSha))
    return uncoveredByPath

  try {
    const rows: any[] = await db
      .selectFrom('coverage_files')
      .select(['path', 'uncovered_lines'])
      .where('repository_id', '=', repositoryId)
      .where('commit_sha', '=', commitSha)
      .execute()

    for (const row of rows) {
      try {
        const parsed = JSON.parse(String(row.uncovered_lines ?? '[]'))
        if (Array.isArray(parsed))
          uncoveredByPath.set(String(row.path), new Set(parsed.map(Number).filter(Number.isInteger)))
      }
      catch {
        // A corrupt row is no data, not "covered".
      }
    }
  }
  catch {
    // No table yet, or a read failure: the diff renders without markers.
  }

  return uncoveredByPath
}
