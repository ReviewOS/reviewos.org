/**
 * Booting the application's router for a test.
 *
 * A thin wrapper, and it used to carry more. Two different programs render
 * `.stx` here: `buddy dev` and the production server go through
 * `bun-plugin-stx`'s own `serve()`, which is handed the components, layouts and
 * partials directories; `route.serve()` goes through bun-router's file routing,
 * which was handed nothing. Its components directory fell back to
 * `resources/views/components`, so `resources/components` - where every
 * component in this project lives - was never looked in, and each one rendered
 * as `[Error loading component: ENOENT …]` inlined into a page that still
 * answered 200.
 *
 * That is fixed in the framework as of `@stacksjs/router` 0.70.308:
 * `configureViewDirectories` fills in the conventional directories inside
 * `serve()`. This file no longer stands in for it, and
 * `tests/e2e/view-components.test.ts` is what says so if it stops happening.
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
