/**
 * The routes this application *declares*, measured where nothing has served a
 * page.
 *
 * `route.routes` is one table shared by every module in the process, and
 * `route.serve()` adds the file-based views to it - 65 of them here. So a test
 * that reads the table gets a different answer depending on whether any e2e
 * file has booted a server first, and `importRoutes()` cannot undo it: it is
 * guarded against running twice, so clearing the table and re-importing leaves
 * it empty.
 *
 * The API surface is what `routes/` declares. A page rendered from
 * `resources/views` is not part of it - it answers HTML, it is not in the
 * OpenAPI document, and a generated client has no use for it - so measuring it
 * as an undocumented endpoint is measuring the wrong thing.
 *
 * Hence a child process. It costs about a second, and it is the difference
 * between a parity check and a parity check that happens to agree with whatever
 * ran before it.
 */

const CHILD = `
const { injectGlobalAutoImports } = await import('@stacksjs/server')
const { route } = await import('@stacksjs/router')

await injectGlobalAutoImports()
await route.importRoutes()

const rows = (route.routes ?? []).map(entry => ({
  method: String(entry.method),
  path: String(entry.path),
}))

await Bun.write(process.env.DECLARED_ROUTES_OUT, JSON.stringify(rows))
`

export interface DeclaredRoute {
  method: string
  path: string
}

/** Booting the application costs a few seconds, and it answers the same twice. */
let pending: Promise<DeclaredRoute[]> | null = null

export async function declaredRoutes(): Promise<DeclaredRoute[]> {
  pending ??= enumerate()

  return await pending
}

async function enumerate(): Promise<DeclaredRoute[]> {
  const out = `${process.cwd()}/storage/framework/runtime/declared-routes.json`

  const child = Bun.spawn(['bun', '-e', CHILD], {
    cwd: process.cwd(),
    env: { ...process.env, DECLARED_ROUTES_OUT: out },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`enumerating the declared routes exited ${code}: ${stderr.slice(-400).trim()}`)

  const rows = await Bun.file(out).json()

  // An empty table would make every caller pass by describing nothing, which is
  // the one failure a coverage test must not have.
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error('the child process reported no routes at all')

  return rows as DeclaredRoute[]
}
