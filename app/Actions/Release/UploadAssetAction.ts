import { Action } from '@stacksjs/actions'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { authorizeRepository } from '../Repo/authorize'
import { assetPath, checksumOf, decideAsset, newAssetKey } from './assets'

/**
 * Attach a built artefact to a release.
 *
 * `repository:settings`, the same as publishing the release itself: an asset is
 * part of the announcement rather than a change to the code, and anybody who
 * can publish a release can put a binary next to it.
 *
 * The bytes are written before the row, and that order is the design. A row
 * pointing at a file that is not there is a download link that 404s and a
 * checksum for nothing; a file with no row is an orphan the storage sweep can
 * find. Only one of those is visible to somebody trying to install software.
 */
export default new Action({
  name: 'UploadReleaseAsset',
  description: 'Attach a file to a release',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const tag = String(request.get('tag_name') ?? '').trim()

    const release = await db
      .selectFrom('releases')
      .select(['id'])
      .where('repository_id', '=', Number(repository.id))
      .where('tag_name', '=', tag)
      .executeTakeFirst()

    if (!release)
      return response.json({ error: 'No release for that tag' }, 404)

    const file = request.file?.('file') ?? request.file?.('asset')
    if (!file)
      return response.json({ error: 'No file was uploaded' }, 422)

    const bytes = new Uint8Array(await file.arrayBuffer())
    const decision = decideAsset(String(file.name ?? ''), bytes.byteLength)

    if (!decision.ok)
      return response.json({ error: decision.error }, decision.status)

    // One name per release. Refused rather than replaced: an asset name is what
    // an install script fetches, and quietly swapping the bytes under a name
    // somebody has already published is the worst version of this endpoint.
    const clash = await db
      .selectFrom('release_assets')
      .select(['id'])
      .where('release_id', '=', Number(release.id))
      .where('name', '=', decision.name)
      .executeTakeFirst()

    if (clash)
      return response.json({ error: `That release already has a file called ${decision.name}` }, 409)

    const key = newAssetKey()
    const path = assetPath(key)!

    try {
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, bytes)
    }
    catch (error) {
      return response.json({ error: `Could not store that file: ${error}` }, 500)
    }

    const created = await db
      .insertInto('release_assets')
      .values({
        release_id: Number(release.id),
        name: decision.name,
        storage_path: path,
        // Recorded as declared, and never used to serve the file. See
        // `assets.ts`: a release asset goes out as an opaque download whatever
        // it says it is.
        content_type: String(file.type ?? 'application/octet-stream').slice(0, 160),
        size_bytes: decision.bytes,
        checksum: checksumOf(bytes),
        download_count: 0,
      })
      .returning(['id'])
      .executeTakeFirst()

    return response.json({
      id: Number(created?.id),
      name: decision.name,
      size_bytes: decision.bytes,
      // Published next to the file, because a checksum nobody can see is a
      // checksum nobody can check.
      checksum: checksumOf(bytes),
      url: `/api/repos/releases/assets?owner=${encodeURIComponent(String(request.get('owner') ?? ''))}`
        + `&repository=${encodeURIComponent(repository.name)}`
        + `&tag_name=${encodeURIComponent(tag)}&name=${encodeURIComponent(decision.name)}`,
    }, 201)
  },
})
