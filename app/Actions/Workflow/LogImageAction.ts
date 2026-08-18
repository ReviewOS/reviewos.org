/**
 * The bytes behind an image a job printed into its log.
 *
 * Separate from `DownloadArtifactAction` because the two answer opposite
 * questions. A download is deliberately an attachment: the bytes came off a
 * machine executing somebody's build, and a browser that renders them in place
 * is a stored cross-site scripting hole with extra steps. An image in a log has
 * to render in place to be an image at all - so this endpoint exists to say,
 * narrowly and in one file, exactly which bytes are allowed to.
 *
 * The policy, in four rules:
 *
 * - **It is an artifact of the run whose log this is.** The event names an
 *   artifact rather than a URL, so the only thing a build can put on this page
 *   is something it uploaded here, under its own run. A URL would let a log
 *   install a tracking pixel that fires whenever a colleague opens the page.
 * - **The type is sniffed, not believed.** `content_type` is whatever the
 *   uploader typed. The first bytes are what a browser will act on, so those
 *   are what decides - and only PNG, JPEG, GIF and WEBP pass.
 * - **SVG never passes.** It is a document that can carry script, and it is the
 *   one image format where "render this in place" means "run this".
 * - **Size is capped.** A hundred-megabyte PNG is not a screenshot, and a log
 *   page that fetches one is a page nobody can open.
 */

import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { artifactPath } from '../Artifact/storage'
import { authorizeRepository } from '../Repo/authorize'

/** What a browser may be asked to render in a log. Sniffed, never trusted. */
export const RENDERABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** The largest thing this will serve inline. Beyond it, the log links instead. */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * What these bytes actually are, from the bytes.
 *
 * Magic numbers rather than the uploader's word. Returns null for anything not
 * in the list, which includes SVG - it has no magic number, being XML, and that
 * is the tidy half of why it is refused rather than the reason.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12)
    return null

  const starts = (...signature: number[]): boolean => signature.every((byte, index) => bytes[index] === byte)

  if (starts(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
    return 'image/png'

  if (starts(0xFF, 0xD8, 0xFF))
    return 'image/jpeg'

  if (starts(0x47, 0x49, 0x46, 0x38))
    return 'image/gif'

  // RIFF....WEBP - the four bytes between are the length, which is not part of
  // the identity.
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return 'image/webp'

  return null
}

export default new Action({
  name: 'LogImage',
  description: 'The bytes of an image a job printed into its log',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    artifact: { rule: schema.string() },
  },

  responses: {
    200: { description: 'The image, inline, with the type its bytes say it is.' },
    404: { description: 'No artifact of that name in this run.' },
    410: { description: 'The artifact expired, or its stored copy is gone.' },
    415: { description: 'The bytes are not a format this will render in place. SVG is refused whatever it contains.' },
  },

  async handle(request: RequestInstance) {
    /*
     * The same permission a log needs, because this is part of one. An
     * instance where reading logs is separable from reading runs is one where
     * a picture in a log must not be the way around it.
     */
    const auth = await authorizeRepository(request, 'workflow:logs')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const number = Number(request.get('number'))
    const name = String(request.get('artifact') ?? '').trim()

    if (!Number.isInteger(number) || number <= 0 || !name)
      return response.json({ error: 'A run number and an artifact name are required' }, 422)

    const row = await db
      .selectFrom('workflow_artifacts')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_artifacts.workflow_run_id')
      .select([
        'workflow_artifacts.digest as digest',
        'workflow_artifacts.size_bytes as size_bytes',
        'workflow_artifacts.expires_at as expires_at',
      ])
      // Scoped to the run the log belongs to, not merely to the repository: an
      // image event in run 12 naming an artifact of run 900 is a job reaching
      // into another run's output, which is not a thing it may do.
      .where('workflow_runs.repository_id', '=', Number(repository.id))
      .where('workflow_runs.number', '=', number)
      .where('workflow_artifacts.name', '=', name)
      .executeTakeFirst()

    if (!row)
      return response.json({ error: 'No artifact by that name in this run' }, 404)

    const expires = row.expires_at ? Date.parse(String(row.expires_at)) : Number.NaN

    if (Number.isFinite(expires) && expires <= Date.now())
      return response.json({ error: 'This artifact has expired' }, 410)

    if (Number(row.size_bytes ?? 0) > MAX_INLINE_IMAGE_BYTES) {
      return response.json({
        error: 'That artifact is too large to show in a log',
        reason: `Images shown in a log are at most ${Math.round(MAX_INLINE_IMAGE_BYTES / (1024 * 1024))}MB. It can still be downloaded from the run's artifacts.`,
      }, 415)
    }

    const file = Bun.file(artifactPath(String(row.digest)))

    if (!(await file.exists()))
      return response.json({ error: 'The stored copy of this artifact is missing' }, 410)

    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
    const type = sniffImage(head)

    if (!type) {
      /*
       * Refused rather than served as `application/octet-stream`. Sending bytes
       * a browser might sniff for itself is the whole hole: `nosniff` closes it
       * on browsers that honour the header, and not serving it closes it
       * everywhere.
       */
      return response.json({
        error: 'Those bytes are not an image this will show in a log',
        reason: 'PNG, JPEG, GIF and WEBP render here. SVG does not: it is a document that can carry script, and rendering it in place would run it.',
      }, 415)
    }

    return new Response(file, {
      headers: {
        'Content-Type': type,
        'Content-Length': String(Number(row.size_bytes) || 0),
        'X-Content-Type-Options': 'nosniff',
        /*
         * Nothing but these bytes. A picture cannot fetch, script, frame or
         * navigate, so even a format this server sniffed wrongly has nowhere to
         * go - the sniff is the first line and this is the second.
         */
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        // A minute, revalidated. An artifact's bytes never change - the digest
        // is its address - but the row above it can expire, and a cached image
        // outliving the expiry would be the promise quietly broken.
        'Cache-Control': 'private, max-age=60, must-revalidate',
      },
    })
  },
})
