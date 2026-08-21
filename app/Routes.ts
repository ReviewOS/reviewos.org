import type { RouteRegistry } from '@stacksjs/router'

export type { RouteDefinition, RouteRegistry } from '@stacksjs/router'

/**
 * Which route files load, and under which prefix.
 *
 * `git` mounts at the root with no prefix because it has to: a plain
 * `git clone https://host/owner/repo.git` asks for
 * `/owner/repo.git/info/refs`, and any prefix would make that URL something
 * only a specially configured client could use.
 *
 * `attachments` mounts at the root for a softer reason: the URL is written into
 * somebody's markdown and then outlives the repository it was uploaded to, so
 * it carries no owner and no repository name and nothing a rename can break.
 *
 * `git` is listed last so its `{owner}/{repository}` patterns, which match
 * almost anything, cannot shadow a more specific route.
 */
export default {
  /*
   * The whole API is rate limited, not a handful of endpoints.
   *
   * "Rate limiting on the API" has to mean the API. Annotating routes one at a
   * time produces a surface where the limit is wherever somebody remembered,
   * and the endpoint that gets hammered is always the one nobody thought of.
   *
   * The default is generous for reads and tight for writes - the design asks
   * clients to poll and then makes polling free with `ETag`, so punishing it
   * would be incoherent, while a thousand comments are somebody's afternoon.
   * Routes that need something else say so with `throttle:<n>,<window>`, which
   * overrides this rather than adding to it.
   */
  api: { path: 'api', middleware: ['throttle', 'measure'] },
  attachments: { path: 'attachments', prefix: '' },
  // Unsubscribing, at the root: the URL goes into an email and into a
  // List-Unsubscribe header, both read by machines that will not follow a
  // redirect from /api to anywhere.
  notifications: { path: 'notifications', prefix: '' },
  // Registers nothing; configures the renderer. See the file for why it must
  // load with the routes rather than in any one server's boot script.
  views: { path: 'views', prefix: '' },
  /*
   * The mirrored actions, at the root and *before* `git`.
   *
   * `/actions/{host}/{owner}/{name}.git/info/refs` would otherwise be caught by
   * git's `{owner}/{repository}` patterns, which would read `actions` as an
   * owner and answer 404 for a repository nobody has.
   */
  /*
   * The identity documents, at the root because the path is fixed: a cloud
   * provider fetches `/.well-known/openid-configuration` and nothing else, so
   * a copy under `/api` is a document nobody will ever ask for.
   */
  wellknown: { path: 'wellknown', prefix: '' },
  actions: { path: 'actions', prefix: '' },
  git: { path: 'git', prefix: '' },
  /*
   * Published sites, at the root and *after* `git`.
   *
   * Last of all, because when Pages is configured this file registers a `/*`
   * catch-all for the Pages hostname. First match wins, so anything registered
   * after it would never run - and a catch-all that shadows the git wire
   * protocol is an instance where nobody can clone.
   */
  pages: { path: 'pages', prefix: '' },
} satisfies RouteRegistry
