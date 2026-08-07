/**
 * Booting the application's router for a test.
 *
 * There is one thing to get right that nothing else says out loud, and getting
 * it wrong is silent. Two different programs render `.stx` in this application:
 * `buddy dev` and the production server go through `bun-plugin-stx`'s own
 * `serve()`, which is handed the components, layouts and partials directories;
 * `route.serve()` goes through bun-router's file routing, which is handed
 * nothing. Its components directory then falls back to
 * `resources/views/components`, and `resources/components` - where every
 * component in this project lives - is never looked in.
 *
 * The page still answers 200. Each component is replaced inline with
 * `[Error loading component: ENOENT ...]`, so a test that asserts on rendered
 * HTML sees a page with every component missing and reads as though the feature
 * under test were broken rather than the harness.
 *
 * **This is a bridge, not the fix.** The fix is in the Stacks router, which now
 * configures these directories inside `serve()` from the conventional layout
 * (`configureViewDirectories` in `storage/framework/core/router/src/`). This
 * application consumes the published `@stacksjs/router`, so it needs the same
 * thing done locally until that release lands - at which point this file can go
 * and every caller can use `route.serve` directly again.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** Where this application keeps the four things a view is assembled from. */
export function viewDirectories(root = process.cwd()): {
  viewsPath: string
  componentsDir?: string
  layoutsDir?: string
  partialsDir?: string
} {
  const at = (relative: string) => resolve(root, relative)
  const first = (...candidates: string[]) => candidates.map(at).find(existsSync)

  return {
    viewsPath: at('resources/views'),
    componentsDir: first('resources/components', 'resources/views/components'),
    layoutsDir: first('resources/views/layouts', 'resources/layouts'),
    partialsDir: first('resources/views/partials', 'resources/partials'),
  }
}

/**
 * Boot the router on an ephemeral port.
 *
 * The view directories are already set: `tests/setup.ts` does it at preload,
 * which is the only point reliably before every test file. It cannot be done
 * here - `route` is a process-wide singleton and `bun test` runs every file in
 * one process, so the first `serve()` builds the view handlers and every later
 * one reuses them. A test file that configured this itself would work alone and
 * silently do nothing when another file served first.
 */
export async function serveForTest(options: { port?: number, hostname?: string } = {}): Promise<{
  server: any
  port: number
}> {
  const { route } = await import('@stacksjs/router')

  await route.importRoutes()

  const server = await route.serve({ port: options.port ?? 0, hostname: options.hostname ?? '127.0.0.1' })
  const port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

  if (!port)
    throw new Error('the router did not report a port')

  return { server, port }
}
