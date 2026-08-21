import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { authorizeRepository } from '../Repo/authorize'
import pages from '../../../config/pages'
import { ensureSite, siteFor } from './site'

/**
 * Reading and changing a repository's published site.
 *
 * The settings surface, and nothing else - it does not build and it does not
 * publish. Publishing happens when a run on the source branch finishes with a
 * `pages` artifact; see `./publish.ts`.
 *
 * ## Turning it on takes `repository:settings`, not write
 *
 * Enabling Pages puts a repository's contents at a URL, and for a `public` site
 * that URL is readable by strangers. That is a disclosure decision, so it takes
 * the ability that governs the repository's other disclosure decisions rather
 * than the one that governs pushing to it - a contributor with write access
 * must not be able to publish a private repository's documentation.
 *
 * Reading the settings takes only read, because "does this repository publish,
 * and where" is a fact about a repository somebody can already see.
 */
export default new Action({
  name: 'Pages',
  description: 'Read or change a repository’s published site',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['show', 'update']), required: false },
    enabled: { rule: schema.boolean(), required: false },
    source_branch: { rule: schema.string(), required: false },
    domain: { rule: schema.string(), required: false },
    visibility: { rule: schema.enum(['public', 'repository']), required: false },
  },

  responses: {
    200: { description: 'The site’s settings and what is currently live.' },
    ...REPOSITORY_ERRORS,
    409: { description: 'Another repository already claims that domain.' },
    422: { description: 'The instance serves no Pages host, or the domain is not a domain.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const operation = String(request.get('operation') ?? 'show').trim() || 'show'
    const auth = await authorizeRepository(request, operation === 'show' ? 'repository:read' : 'repository:settings')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repository = auth.context.repository
    const repositoryId = Number(repository.id)

    if (operation === 'show') {
      const site = await siteFor(repositoryId)

      return response.json({ pages: describe(site, String(repository.name ?? ''), await ownerHandleOf(repository)) })
    }

    /*
     * An instance with no Pages host cannot publish, and says so rather than
     * storing a setting that does nothing.
     *
     * The alternative - accept it and serve nothing - is the shape of failure
     * this whole feature is careful about: somebody switches Pages on, waits
     * for a build, and finds a URL that was never going to answer.
     */
    if (!pages.domain)
      return response.json({ error: 'This instance serves no Pages host. An operator sets PAGES_DOMAIN.' }, 422)

    const site = await ensureSite(repositoryId)
    const changes: Record<string, unknown> = {}

    if (request.get('enabled') !== undefined)
      changes.enabled = request.get('enabled') === true || String(request.get('enabled')) === 'true'

    if (request.get('visibility') !== undefined)
      changes.visibility = String(request.get('visibility')) === 'public' ? 'public' : 'repository'

    if (request.get('source_branch') !== undefined)
      changes.source_branch = String(request.get('source_branch') ?? '').trim().slice(0, 255)

    if (request.get('domain') !== undefined) {
      const domain = String(request.get('domain') ?? '').trim().toLowerCase()

      if (domain) {
        if (!pages.customDomains)
          return response.json({ error: 'This instance does not serve custom domains for Pages.' }, 422)

        if (!isDomain(domain))
          return response.json({ error: 'That is not a domain name.' }, 422)

        // Refused rather than overwritten. A domain answered by two
        // repositories is a hijack, and the second one to claim it must not
        // silently take the first one's traffic.
        const taken = await db
          .selectFrom('pages_sites')
          .select(['repository_id'])
          .where('domain', '=', domain)
          .executeTakeFirst()
          .catch(() => null)

        if (taken && Number(taken.repository_id) !== repositoryId)
          return response.json({ error: 'Another repository already publishes at that domain.' }, 409)
      }

      changes.domain = domain || null
    }

    if (Object.keys(changes).length > 0) {
      await db
        .updateTable('pages_sites')
        .set(changes as any)
        .where('id', '=', site.id)
        .execute()
        .catch(() => null)

      /*
       * Audited, because this is a disclosure decision.
       *
       * "Who made this repository's documentation public, and when" is a
       * question somebody asks after the fact, and a settings page that only
       * shows the current value cannot answer it.
       */
      await auditEvent('pages:updated', {
        subject: { type: 'repository', id: repositoryId },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId,
        detail: changes,
      }).catch(() => null)
    }

    const updated = await siteFor(repositoryId)

    return response.json({ pages: describe(updated, String(repository.name ?? ''), await ownerHandleOf(repository)) })
  },
})

/**
 * The owner's handle, which is the site's subdomain.
 *
 * Read from the owner rather than split out of `full_name`: a rename writes the
 * owner row and the repository's `full_name` separately, and the URL shown on a
 * settings page must be the one that actually answers.
 */
async function ownerHandleOf(repository: any): Promise<string> {
  const table = String(repository.owner_type) === 'organization' ? 'organizations' : 'users'

  const row = await db
    .selectFrom(table as any)
    .select(['handle'])
    .where('id', '=', Number(repository.owner_id))
    .executeTakeFirst()
    .catch(() => null)

  return String((row as any)?.handle ?? '')
}

/** A hostname, loosely: labels of letters, digits and hyphens, at least two. */
function isDomain(value: string): boolean {
  return value.length <= 253 && /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value)
}

/**
 * What a settings page shows.
 *
 * Including the URL, computed rather than stored: it is derived from the
 * instance's Pages host and the repository's name, both of which can change,
 * and a stored copy would be the one that goes stale after a rename.
 */
function describe(site: Awaited<ReturnType<typeof siteFor>>, name: string, owner: string) {
  const url = site?.domain
    ? `https://${site.domain}/`
    : pages.domain && owner
      ? `https://${owner}.${pages.domain}/${name}/`
      : null

  return {
    // A row that does not exist and a row that is switched off are the same
    // answer to a settings page: Pages is off here.
    enabled: !!site?.enabled,
    available: !!pages.domain,
    customDomainsAvailable: pages.customDomains,
    source_branch: site?.source_branch ?? '',
    domain: site?.domain ?? null,
    visibility: site?.visibility ?? 'repository',
    url,
    live: site?.live_sha
      ? { sha: site.live_sha, at: site.live_at, run: site.live_run_id }
      : null,
    last_error: site?.last_error || null,
  }
}
