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
 * It is listed last so its `{owner}/{repository}` patterns, which match almost
 * anything, cannot shadow a more specific route.
 */
export default {
  api: 'api',
  git: { path: 'git', prefix: '' },
} satisfies RouteRegistry
