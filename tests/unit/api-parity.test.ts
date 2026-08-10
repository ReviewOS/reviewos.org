// Anything a page can show, a token can fetch.
//
// The rule phase 12 opens with, and until now it was a rule somebody checked by
// hand. That check found two violations while the MCP tools were being built -
// reading one pull request, and the review queue - and the second one mattered:
// `reviewQueue()` had exactly one caller, a view, so the interface could answer
// *what should I look at* and the API could not. An agent had to scrape the page
// or reconstruct the ordering itself.
//
// Two found by hand means the next one is found by hand too, eventually, by
// somebody who needed it and worked around it instead. So the check is
// mechanical now.
//
// ## What it actually proves
//
// That every module under `app/Actions/` which a `.stx` file imports is also
// reachable from a registered route - either because it *is* a route's action,
// or because a route's action imports it. That is the honest mechanical shadow
// of the rule: it cannot tell whether the API's answer is as *complete* as the
// page's, but it catches the shape both known violations had, which is a page
// reaching into server code that no route reaches.

import { describe, expect, test } from 'bun:test'

/** `'Actions/Pull/QueueAction'` out of every route registration. */
async function routeTargets(): Promise<string[]> {
  const targets = new Set<string>()

  for await (const path of new Bun.Glob('routes/*.ts').scan({ cwd: process.cwd() })) {
    const source = await Bun.file(path).text()

    for (const match of source.matchAll(/'(Actions\/[A-Za-z0-9/_-]+)'/g))
      targets.add(match[1]!)
  }

  return [...targets].sort()
}

/**
 * Module specifiers a file imports, resolved to repository-relative paths.
 *
 * Static and dynamic both. Actions in this codebase reach for their
 * dependencies with `await import(...)` as often as with `from` - it is how a
 * heavy module stays off the boot path - and a checker that only saw the static
 * form reported two endpoints as missing that had just been written.
 */
async function importsOf(path: string): Promise<string[]> {
  const source = await Bun.file(path).text()
  const found: string[] = []

  for (const match of source.matchAll(/(?:from\s+|import\(\s*)'([^']+)'/g)) {
    const specifier = match[1]!

    if (!specifier.startsWith('.'))
      continue

    // Resolved against the importing file, then made repository-relative and
    // stripped of its extension, so the two sides compare as the same string.
    const resolved = new URL(specifier, new URL(path, `file://${process.cwd()}/`)).pathname
    const relative = resolved.replace(`${process.cwd()}/`, '').replace(/\.(ts|stx)$/, '')

    found.push(relative)
  }

  return found
}

/**
 * Every `app/Actions/` module a route can reach, following imports all the way.
 *
 * Transitive rather than one hop, and bounded by the directory rather than by a
 * hop count. The first version stopped after one hop and reported two modules
 * that *are* reachable through an intermediate - `Notification/inbox` sits
 * behind `Notification/read`, which the list endpoint imports - and a check that
 * cries wolf twice is a check somebody deletes.
 *
 * Staying inside `app/Actions/` is what keeps it meaningful. "Reachable from a
 * route" is exactly the property under test: if a module is in this set, some
 * endpoint's code path calls it. What it still cannot tell is whether the
 * endpoint *exposes* what the module returns - that part is a human question,
 * and the header says so.
 */
async function reachableFromRoutes(): Promise<Set<string>> {
  const reachable = new Set<string>()
  const queue: string[] = []

  for (const target of await routeTargets()) {
    reachable.add(`app/${target}`)
    queue.push(`app/${target}`)
  }

  while (queue.length > 0) {
    const module = queue.pop()!
    const path = `${module}.ts`

    if (!await Bun.file(path).exists())
      continue

    for (const imported of await importsOf(path)) {
      if (!imported.startsWith('app/Actions/') || reachable.has(imported))
        continue

      reachable.add(imported)
      queue.push(imported)
    }
  }

  return reachable
}

/** Every `app/Actions/` module the interface imports, and which file wants it. */
async function reachedByViews(): Promise<Array<{ view: string, module: string }>> {
  const wanted: Array<{ view: string, module: string }> = []

  for await (const path of new Bun.Glob('resources/**/*.stx').scan({ cwd: process.cwd() })) {
    for (const imported of await importsOf(path)) {
      if (imported.startsWith('app/Actions/'))
        wanted.push({ view: path, module: imported })
    }
  }

  return wanted
}

describe('interface and API parity', () => {
  test('every action a page reaches is reachable from a route', async () => {
    /*
     * The check that would have caught both known violations the day they
     * landed, rather than months later when somebody went looking.
     *
     * A failure here is not "add a route to make the test pass" - it is a
     * question worth answering: this page can do something a token cannot, so
     * either the endpoint is missing or the page should not have reached past
     * the API to get it.
     */
    const reachable = await reachableFromRoutes()
    const gaps = (await reachedByViews()).filter(entry => !reachable.has(entry.module))

    // Reported with the view, so a failure says which page found the gap.
    expect(gaps).toEqual([])
  })

  test('every route target names a file that exists', async () => {
    /*
     * A route registered against a path with a typo in it fails at request
     * time, as a 500 on one endpoint, which is exactly the failure nobody
     * notices until somebody uses that endpoint.
     *
     * Checked here rather than by booting the router, because the router only
     * resolves an action when a request arrives for it - a broken registration
     * is silent until then.
     */
    const missing: string[] = []

    for (const target of await routeTargets()) {
      if (!await Bun.file(`app/${target}.ts`).exists() && !await Bun.file(`storage/framework/defaults/app/${target}.ts`).exists())
        missing.push(target)
    }

    expect(missing).toEqual([])
  })

  test('the parity check is looking at something', async () => {
    // A test whose inputs are empty passes forever and proves nothing. Both
    // sides have to be non-trivial for the assertion above to mean anything -
    // and the view side would silently empty if `.stx` imports ever moved to a
    // different syntax.
    expect((await routeTargets()).length).toBeGreaterThan(50)
    expect((await reachedByViews()).length).toBeGreaterThan(0)
  })
})
