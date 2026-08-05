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
  api: 'api',
  attachments: { path: 'attachments', prefix: '' },
  git: { path: 'git', prefix: '' },
} satisfies RouteRegistry
