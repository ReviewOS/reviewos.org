import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { browseContext } from '../Browse/context'
import { assetHeaders } from './assets'
import { isDraft } from '../Repo/releases'

/**
 * Download a release asset.
 *
 * Through an action rather than as a static file, because an asset on a private
 * repository is exactly as private as the repository, and a directory served by
 * the web server cannot know that. The unguessable key is a name, not access
 * control.
 *
 * A draft's assets are not downloadable by anybody who cannot see the draft.
 * That is the whole point of a draft: the release is being prepared, and a
 * binary reachable before the announcement is a release that happened without
 * anybody saying so.
 */
export default new Action({
  name: 'DownloadReleaseAsset',
  description: 'Download a file attached to a release',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    name: { rule: schema.string() },
    ref: { rule: schema.string() },
    tag_name: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const { repository } = browse.context
    const tag = String(request.get('tag_name') ?? '').trim()
    const name = String(request.get('name') ?? '').trim()

    if (!tag || !name)
      return response.json({ error: 'Not found' }, 404)

    const release = await db
      .selectFrom('releases')
      .selectAll()
      .where('repository_id', '=', Number(repository.id))
      .where('tag_name', '=', tag)
      .executeTakeFirst()

    // A draft reads as missing rather than forbidden, the same answer a private
    // repository gives: "you may not have this" confirms it exists, and the
    // existence of an unannounced release is the thing being kept.
    if (!release || isDraft(release))
      return response.json({ error: 'Not found' }, 404)

    const asset = await db
      .selectFrom('release_assets')
      .select(['id', 'name', 'storage_path', 'size_bytes'])
      .where('release_id', '=', Number(release.id))
      .where('name', '=', name)
      .executeTakeFirst()

    if (!asset)
      return response.json({ error: 'Not found' }, 404)

    const { blobStore } = await import('../Git/blobs')
    const { assetKeyFrom } = await import('./assets')
    const store = await blobStore()
    const key = assetKeyFrom(asset.storage_path)
    const stream = key ? await store.get(key).catch(() => null) : null

    if (!stream)
      return response.json({ error: 'Not found' }, 404)

    // Counted before the bytes go out, because afterwards there is no response
    // left to write into and a client that cancels mid-download still asked for
    // it. Never fails the download: a count is a nicety and the file is not.
    await countDownload(Number(asset.id)).catch(() => {})

    return new Response(stream, {
      headers: assetHeaders(String(asset.name), Number(asset.size_bytes ?? 0)),
    })
  },
})

/**
 * One more download.
 *
 * Recomputed from nothing - there is nothing to recompute from, since a
 * download leaves no row - so this is the one counter in the product that has
 * to be an increment. It is written as a read and a conditional write so two
 * downloads at once cannot both read 5 and write 6: whichever loses sees a
 * different current value and simply does not retry, because a count that is
 * occasionally one short is worth less than the latency of making it exact.
 */
async function countDownload(assetId: number): Promise<void> {
  const row = await db
    .selectFrom('release_assets')
    .select(['download_count'])
    .where('id', '=', assetId)
    .executeTakeFirst()

  const current = Number(row?.download_count ?? 0)

  await db
    .updateTable('release_assets')
    .set({ download_count: current + 1 })
    .where('id', '=', assetId)
    .where('download_count', '=', current)
    .execute()
}
