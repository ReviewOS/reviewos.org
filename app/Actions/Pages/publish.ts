/**
 * Making a run's output the live site.
 *
 * A run finished, it uploaded an artifact called `pages`, and this is what
 * turns that into something a stranger's browser can read. It is the whole of
 * the "deploy" half of Pages, and it deliberately does no building — see
 * `app/Models/PagesSite.ts` for why the instance never runs a repository's
 * documentation toolchain.
 *
 * ## Nothing here may fail a run
 *
 * This is called from the settler, at the moment a run records its conclusion.
 * A publish that threw would take the conclusion with it, so every path
 * returns a reason instead — and the reason is written to the site row, because
 * "my docs did not update" is answered by a sentence on the settings page and
 * by nothing else.
 *
 * ## Why the branch is checked here rather than trusted
 *
 * A site has an address strangers read. Any run that produced a `pages`
 * artifact could otherwise replace it, which means a pull request from a fork
 * could — that is the fork rule from
 * [the threat model](../../../docs/ci-threat-model.md) applied to publishing
 * rather than to secrets. Only a run on the configured source branch publishes.
 */

import { db } from '@stacksjs/database'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readArtifactBytes } from '../Artifact/read'
import { PAGES_ARTIFACT, siteDirectory, siteFor } from './site'
import { maybeGunzip, untar } from './untar'

export interface PublishOutcome {
  ok: boolean
  /** How many files were written, when it worked. */
  files?: number
  /** One sentence, when it did not. Written to the row and shown in settings. */
  reason?: string
}

/**
 * The branch a run has to be on to publish.
 *
 * The site's `source_branch` when it names one, else the repository's default
 * branch. Reading the default rather than requiring the field means a
 * repository that switched Pages on and said nothing else publishes from the
 * branch everybody means, and a repository that later renames its default
 * branch keeps working instead of silently stopping.
 */
export async function sourceBranchFor(repositoryId: number, configured: string): Promise<string> {
  if (configured)
    return configured

  const repository = await db
    .selectFrom('repositories')
    .select(['default_branch'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()
    .catch(() => null)

  return String(repository?.default_branch ?? 'main')
}

/** The branch a run's ref names, or empty when the run was not on a branch. */
export function branchOfRef(ref: unknown): string {
  const value = String(ref ?? '')

  return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : ''
}

/**
 * Publish a completed run's site, if it has one to publish.
 *
 * Returns `ok: false` with no reason recorded for the ordinary cases — no site
 * configured, wrong branch, no `pages` artifact — because those are not
 * failures. Almost every run in a repository with Pages on is a run that was
 * never going to publish, and writing "this run had no pages artifact" to the
 * row on every one of them would bury the one message that matters.
 */
export async function publishRun(runId: number): Promise<PublishOutcome> {
  const run = await db
    .selectFrom('workflow_runs')
    .select(['id', 'repository_id', 'head_sha', 'event_ref', 'state'])
    .where('id', '=', runId)
    .executeTakeFirst()
    .catch(() => null)

  if (!run)
    return { ok: false }

  if (String(run.state) !== 'succeeded')
    return { ok: false }

  const repositoryId = Number(run.repository_id)
  const site = await siteFor(repositoryId)

  if (!site || !site.enabled)
    return { ok: false }

  const branch = branchOfRef(run.event_ref)
  const wanted = await sourceBranchFor(repositoryId, site.source_branch)

  if (!branch || branch !== wanted)
    return { ok: false }

  const artifact = await db
    .selectFrom('workflow_artifacts')
    .select(['id', 'digest', 'blob_key', 'size_bytes'])
    .where('workflow_run_id', '=', runId)
    .where('name', '=', PAGES_ARTIFACT)
    .executeTakeFirst()
    .catch(() => null)

  // A run on the source branch that published nothing is the common case: a
  // test run, a lint run, anything that is not the docs build. Silent.
  if (!artifact)
    return { ok: false }

  const sha = String(run.head_sha ?? '')

  if (!/^[0-9a-f]{7,64}$/i.test(sha))
    return await fail(site.id, 'The run has no commit to publish from.')

  const bytes = await readArtifactBytes(artifact as any).catch(() => null)

  if (!bytes)
    return await fail(site.id, 'The build uploaded a `pages` artifact, but its bytes are no longer in the store.')

  let archive: Uint8Array
  try {
    archive = maybeGunzip(bytes)
  }
  catch {
    return await fail(site.id, 'The `pages` artifact is gzipped but could not be decompressed.')
  }

  const { files, error } = untar(archive)

  if (error)
    return await fail(site.id, error)

  if (files.length === 0)
    return await fail(site.id, 'The `pages` artifact is empty, or is not a tar archive. Build the site, then `tar -czf pages.tar.gz -C dist .`.')

  if (!files.some(file => file.name === 'index.html'))
    return await fail(site.id, 'The archive has no `index.html` at its root. Archive the contents of the output directory, not the directory itself.')

  const directory = siteDirectory(repositoryId, sha)

  /*
   * Written in full before the row moves, and the old tree removed only after.
   *
   * The order is the whole point: a visitor whose request lands mid-publish
   * reads the tree the row still names, which is either entirely the old site
   * or entirely the new one. Extracting over the live directory would serve a
   * page whose stylesheet had been deleted and whose replacement had not
   * arrived - a site that looks broken rather than old.
   */
  const previous = site.live_sha

  try {
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })

    for (const file of files) {
      const target = join(directory, file.name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.bytes)
    }
  }
  catch (error) {
    return await fail(site.id, `The site could not be written to disk: ${error instanceof Error ? error.message : 'unknown error'}`)
  }

  await db
    .updateTable('pages_sites')
    .set({
      live_artifact_id: Number(artifact.id),
      live_run_id: runId,
      live_sha: sha,
      live_at: new Date().toISOString(),
      last_error: '',
    })
    .where('id', '=', site.id)
    .execute()
    .catch(() => null)

  /*
   * And only the previous commit's directory, by the name it was written under.
   *
   * Never a sweep of the parent. A recursive delete that walks up from a
   * computed path is how a cleanup once removed a checkout and its siblings;
   * here the single thing removed is the one directory this site had before,
   * and only when it is not the one just written.
   */
  if (previous && previous !== sha)
    await rm(siteDirectory(repositoryId, previous), { recursive: true, force: true }).catch(() => null)

  return { ok: true, files: files.length }
}

/** Record why a publish did not happen, and say so to the caller. */
async function fail(siteId: number, reason: string): Promise<PublishOutcome> {
  await db
    .updateTable('pages_sites')
    .set({ last_error: reason.slice(0, 500) })
    .where('id', '=', siteId)
    .execute()
    .catch(() => null)

  return { ok: false, reason }
}
