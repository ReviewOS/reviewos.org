import type { ServerConfig } from '@stacksjs/types'

/**
 * **What the page process hands to the API process.**
 *
 * A deployed instance runs two: the page server owns `/`, the API server owns
 * the routes in `app/Routes.ts`, and the page server proxies to it. What it
 * proxies is decided here rather than by the route table, because the route
 * table is registered in the other process - possibly on another host - and
 * cannot be consulted from this one. The framework's own note on this is in
 * `ApiProxyOptions`.
 *
 * The default rule covers `/api/**` and every mutating verb, which is why the
 * application's forms have always worked. It does not cover a GET at a path of
 * its own, and the git wire protocol is exactly that: `git clone` opens with
 * `GET /{owner}/{repository}.git/info/refs?service=git-upload-pack`.
 *
 * So **clone and push did not work on this instance at all**. Not for a
 * repository, not for a visitor, not once since it was deployed: the page
 * server answered that GET with a rendered HTML page, git read it as a
 * repository that does not exist, and the failure said `not found` - which
 * reads as a permissions problem or a typo rather than as a missing route.
 * Nothing logged it, because from the page server's side it was an ordinary
 * request for a page.
 *
 * `/git/` is the fix, and a prefix is the only wildcard this configuration
 * has. `routes/git.ts` answers under it as well as at the root, `parseGitUrl`
 * takes the mount off, `cloneUrlFor` advertises it, and `git` is a reserved
 * handle so the mount can never collide with somebody's namespace.
 */
export default {
  proxy: {
    /*
     * `/_pages/` joins `/git/` for the same reason `/git/` is here at all: it
     * is a GET at a path of its own, so the default rule - `/api/**` plus every
     * mutating verb - does not cover it, and the page process would answer a
     * request for somebody's published documentation with a rendered forge
     * page. Which reads, to whoever published it, as Pages not working.
     */
    prefixes: ['/git/', '/_pages/'],
  },
} satisfies ServerConfig
