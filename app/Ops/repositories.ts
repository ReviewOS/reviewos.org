/**
 * Do the repository rows and the directories on disk agree.
 *
 * The check somebody runs after a restore, and the reason it exists is the one
 * sentence that matters in the backup guide: **Postgres and `storage/repos`
 * have to come from the same moment.** A database restored to a point after the
 * repository snapshot has pull requests whose commits are not on disk; the other
 * way round has commits nothing references.
 *
 * Neither reports an error. The pages render, the API answers, and the first
 * person to clone finds out. That is what this looks for.
 *
 * **It reports and never repairs.** Both kinds of mismatch have two plausible
 * fixes - restore the other half, or delete this one - and which is right
 * depends on which snapshot was the good one. A command that guessed would
 * eventually delete the only copy of something.
 *
 * ## The root is a parameter, and that came from actually using this
 *
 * It used to read `storage/repos` and nothing else, which meant the only way to
 * check a restore was to restore *over the live instance first* - the exact
 * opposite of what the guide asks for, which is a rehearsal against a copy
 * before anybody needs one. A check that can only be run after the dangerous
 * step is a check nobody runs at the moment it would help.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../Actions/Git/storage'

export type ProblemKind = 'missing-directory' | 'unreadable' | 'orphan-directory'

export interface Problem {
  kind: ProblemKind
  /** The repository, as `owner/name`, or the path for an orphan. */
  what: string
  detail?: string
}

export interface RepositoryReport {
  checked: number
  problems: Problem[]
}

export interface CheckOptions {
  /**
   * Where the repositories are. Defaults to this instance's own.
   *
   * Pointed somewhere else to rehearse a restore: `DB_DATABASE` names the
   * restored database and this names the restored directory, so the pair can be
   * checked against each other without touching what is running.
   */
  root?: string
}

export async function checkRepositories(options: CheckOptions = {}): Promise<RepositoryReport> {
  const db = (globalThis as any).db
  const root = options.root ?? REPOSITORY_ROOT

  const rows: any[] = await db
    .selectFrom('repositories')
    .select(['id', 'name', 'owner_type', 'owner_id', 'disk_path'])
    .execute()

  const problems: Problem[] = []
  const expected = new Set<string>()

  for (const row of rows) {
    const relative = String(row.disk_path ?? '')
    if (!relative) {
      problems.push({
        kind: 'missing-directory',
        what: String(row.name ?? row.id),
        detail: 'the row records no path at all',
      })
      continue
    }

    expected.add(relative)

    const path = join(root, relative)

    if (!existsSync(path)) {
      problems.push({ kind: 'missing-directory', what: relative, detail: path })
      continue
    }

    /*
     * Readable *by git*, not merely present. A directory that exists and is not
     * a repository - an empty one left by a failed clone, or a half-extracted
     * archive - passes every check that only asks whether the path is there,
     * and fails at the first fetch.
     */
    const readable = await gitCanRead(path)
    if (!readable.ok)
      problems.push({ kind: 'unreadable', what: relative, detail: readable.error })
  }

  /*
   * The other direction: a directory with no row.
   *
   * Worth reporting because it is the shape of the mistake that loses data. A
   * repository nothing references is invisible in the interface, so the next
   * person cleaning up disk space deletes it, and the row it needed was in the
   * half of the backup nobody restored.
   */
  for (const path of directoriesUnder(root)) {
    if (!expected.has(path))
      problems.push({ kind: 'orphan-directory', what: path, detail: 'on disk, with no repository row' })
  }

  return { checked: rows.length, problems }
}

/** Whether git can read this as a repository. */
async function gitCanRead(path: string): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    const child = Bun.spawn(['git', '--git-dir', path, 'rev-parse', '--git-dir'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    return code === 0 ? { ok: true } : { ok: false, error: stderr.trim().split('\n')[0] ?? `git exited ${code}` }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Every `owner/name.git` under the root.
 *
 * Two levels deep and no further, because that is the layout - anything deeper
 * is inside a repository and not one itself, and walking into it would report
 * every `objects/pack` as an orphan.
 */
function directoriesUnder(root: string): string[] {
  const found: string[] = []

  if (!existsSync(root))
    return found

  for (const owner of readdirSync(root, { withFileTypes: true })) {
    if (!owner.isDirectory())
      continue

    for (const repository of readdirSync(join(root, owner.name), { withFileTypes: true })) {
      if (repository.isDirectory())
        found.push(`${owner.name}/${repository.name}`)
    }
  }

  return found
}
