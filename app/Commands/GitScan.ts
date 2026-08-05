import type { CLI } from '@stacksjs/types'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import, and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { repositoryPaths } from '../Actions/Git/hooks'
import { instancePatterns } from '../Actions/Git/patterns'
import { runGit } from '../Actions/Git/git'
import { scanDiff } from '../Actions/Git/secrets'

/**
 * Scan a repository's existing history for credentials.
 *
 * Push protection only ever sees what arrives after it was turned on, and every
 * repository on this instance predates it. This is how somebody finds out what
 * is already in there.
 *
 * **It reports and does not reject**, which is the whole difference between
 * this and the pre-receive gate. There is nothing left to refuse: the commits
 * are in the repository, in every clone anybody has taken, and in the reflog.
 * Rewriting that history is a decision with consequences for everybody who has
 * a copy - so this prints what it found and stops, and the response to a real
 * finding is to rotate the credential, which is the only step that actually
 * ends the exposure. Removing it from history is tidying up afterwards.
 *
 *     buddy git:scan --owner stacks --name stacks
 *     buddy git:scan --all --limit 2000
 */
export default function (buddy: CLI): void {
  buddy
    .command('git:scan', 'Scan a repository history for credentials, reporting rather than rejecting')
    .option('--owner <owner>', 'Owner handle')
    .option('--name <name>', 'Repository name')
    .option('--all', 'Every repository on this instance')
    .option('--limit <count>', 'How many commits back to read', { default: '1000' })
    .action(async (options: { owner?: string, name?: string, all?: boolean, limit?: string }) => {
      const limit = Math.max(1, Math.min(Number(options.limit ?? 1000) || 1000, 20_000))

      let rows: any[] = []

      if (options.all) {
        rows = await db.selectFrom('repositories').select(['id', 'name', 'disk_path', 'owner_type', 'owner_id']).execute()
      }
      else {
        if (!options.owner || !options.name) {
          console.error('Give --owner and --name, or --all.')
          process.exit(1)
        }

        rows = await db
          .selectFrom('repositories')
          .select(['id', 'name', 'disk_path', 'owner_type', 'owner_id'])
          .where('name', '=', String(options.name))
          .execute()

        // The owner is matched after the fact rather than joined: the column is
        // polymorphic, and one extra query per candidate is cheaper than
        // getting a polymorphic join wrong.
        const matched: any[] = []
        for (const row of rows) {
          const table = row.owner_type === 'organization' ? 'organizations' : 'users'
          const owner = await db.selectFrom(table).select(['handle']).where('id', '=', Number(row.owner_id)).executeTakeFirst()
          if (String(owner?.handle ?? '').toLowerCase() === String(options.owner).toLowerCase())
            matched.push(row)
        }
        rows = matched
      }

      if (rows.length === 0) {
        console.error('No such repository.')
        process.exit(1)
      }

      const extra = await instancePatterns()
      let total = 0

      for (const row of rows) {
        const path = repositoryPaths(String(row.disk_path ?? '')).absolute

        const result = await runGit(path, [
          'log',
          `--max-count=${limit}`,
          '--patch',
          '--no-color',
          '--no-renames',
          '--unified=0',
          '--all',
        ], { timeoutMs: 300_000 })

        if (!result.ok) {
          console.error(`${row.disk_path}: could not read history`)
          continue
        }

        const findings = scanDiff(result.stdout, extra)
        total += findings.length

        if (findings.length === 0) {
          console.error(`${row.disk_path}: nothing found in the last ${limit} commits`)
          continue
        }

        console.error('')
        console.error(`${row.disk_path}: ${findings.length} finding${findings.length === 1 ? '' : 's'}`)
        for (const finding of findings)
          console.error(`  ${finding.path}:${finding.line}  looks like ${finding.name} (${finding.excerpt})`)
      }

      if (total > 0) {
        console.error('')
        console.error('These are already in the history and in every clone of it.')
        console.error('Rotate the credentials first - that is the step that ends the exposure.')
        console.error('Removing them from history afterwards is tidying up, and rewrites everybody\'s copy.')
      }

      // Reporting, not gating: a finding is information rather than a failure,
      // and exiting non-zero would make this unusable in a scheduled job that
      // is supposed to keep running.
      process.exit(0)
    })
}
