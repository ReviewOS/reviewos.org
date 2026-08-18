import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { cookieJarFromHeader, currentUser } from '../Identity/lookup'
import { ownerRepositories, profileReadme, REPOSITORIES_PER_PAGE } from './read'

/**
 * An owner's profile: who they are, what they have, and what they wrote.
 *
 * The same three things `/{handle}` renders, from the same module, because the
 * rule is that anything a page can show a token can fetch. It could not: the
 * profile page was the only caller of `ownerRepositories` and `profileReadme`,
 * so an agent asking "what does this account have" had to scrape the page or
 * walk `/explore` and filter it by hand.
 *
 * **Private repositories only to the owner themselves.** Exactly the rule the
 * page follows, and deliberately with no middle case for a collaborator: a
 * profile whose contents depend on a permission graph is one whose first bug is
 * a disclosure, and a repository a collaborator may see is reachable from its
 * own URL anyway.
 *
 * Unauthenticated readers are welcome, and get the public half. That is what a
 * profile is.
 */
export default new Action({
  name: 'ShowOwner',
  description: "An account or organization, its repositories, and its profile README",
  method: 'GET',

  validations: {
    owner: { rule: schema.string().required() },
    /** Narrows by name and description, the way the page's search box does. */
    q: { rule: schema.string() },
    page: { rule: schema.number() },
    per_page: { rule: schema.number() },
  },

  responses: {
    200: { description: 'The owner, one page of their repositories, and their profile README when they have written one.' },
    404: { description: 'No account or organization with that handle. An alias that has moved answers this too; follow `/{handle}` for the redirect.' },
  },

  async handle(request: RequestInstance) {
    const handle = String(request.get('owner') ?? '').trim().toLowerCase()

    if (!handle)
      return response.json({ error: 'An owner handle is required' }, 422)

    // A user first, then an organization, because a handle is unique across
    // both and resolving the other way round would let an organization shadow
    // an account with the same name.
    const account = await db
      .selectFrom('users')
      .select(['id', 'handle', 'name', 'bio', 'avatar_url', 'location', 'website', 'created_at'])
      .where('handle', '=', handle)
      .executeTakeFirst()

    const organization = account
      ? null
      : await db
          .selectFrom('organizations')
          // `handle` is the URL segment; `name` is the display name and is
          // nullable, so looking one up by name finds nothing for every
          // organization that never set one.
          .select(['id', 'handle', 'name', 'description', 'avatar_url', 'website', 'created_at'])
          .where('handle', '=', handle)
          .executeTakeFirst()

    if (!account && !organization)
      return response.json({ error: 'Not found' }, 404)

    const viewer = await currentUser(request)
    const ownerId = Number(account?.id ?? organization?.id ?? 0)
    const ownerType = account ? 'user' : 'organization'
    const isSelf = Boolean(viewer && account && Number(viewer.id) === Number(account.id))

    const perPage = Number(request.get('per_page') ?? 0)
    const repositories = await ownerRepositories({
      ownerId,
      ownerType,
      includePrivate: isSelf,
      query: String(request.get('q') ?? '').slice(0, 100),
      page: request.get('page'),
      perPage: perPage > 0 ? Math.min(perPage, 100) : REPOSITORIES_PER_PAGE,
    })

    /*
     * Rendered rather than raw, which is the same answer the page gets.
     *
     * A profile README is written by whoever owns the handle, so the sanitising
     * is the point rather than a convenience - `renderMarkdownHighlighted` is
     * where it lives, and handing a caller the raw markdown instead would move
     * that decision to them.
     *
     * The cookie jar, because the repository behind it is resolved through
     * `repositoryForView` and a session is the only credential that reaches.
     * A caller on a token therefore sees a public profile README and not a
     * private one, which is a narrower answer than the page gives its owner
     * and never a wider one.
     */
    const readme = await profileReadme(
      handle,
      Boolean(organization),
      cookieJarFromHeader(request.headers?.get?.('cookie') ?? request.header?.('cookie')),
    )

    return response.json({
      owner: {
        handle,
        kind: account ? 'user' : 'organization',
        name: String((account ?? organization)?.name ?? '') || null,
        about: String((account?.bio ?? organization?.description) ?? '') || null,
        avatar_url: String((account ?? organization)?.avatar_url ?? '') || null,
        location: account ? String(account.location ?? '') || null : null,
        website: String((account ?? organization)?.website ?? '') || null,
        created_at: (account ?? organization)?.created_at ?? null,
      },
      repositories: repositories.rows,
      readme,
      page: repositories.page,
      pages: repositories.pages,
      per_page: repositories.perPage,
      /** Everything the caller may see, before the search narrowed it. */
      total: repositories.total,
      /** How many the search matched. Equal to `total` when there is no search. */
      matched: repositories.matched,
    })
  },
})
