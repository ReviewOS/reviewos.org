// Every screen changes state through the public API, and nothing else.
//
// The rule is easy to state and easy to lose: a control the interface has and
// the API does not is how a product grows a second, undocumented way to change
// its own state - and the second way is the one with no token scope, no audit
// event, no rate limit and no OpenAPI entry, because all of those were built
// for the first.
//
// It is asserted here rather than in prose because prose does not fail. A form
// posted at a route that does not exist renders perfectly and 404s on submit,
// which is the sort of thing nobody notices until somebody presses the button.

import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { declaredRoutes, pathsOf } from '../../app/Docs/reference'

/** Every `<form>` target in the interface, with the file it was written in. */
async function formActions(): Promise<Array<{ path: string, action: string, method: string }>> {
  const found: Array<{ path: string, action: string, method: string }> = []

  for (const directory of ['resources/views', 'resources/components']) {
    for await (const file of new Glob('**/*.stx').scan({ cwd: directory })) {
      const path = `${directory}/${file}`
      const source = await Bun.file(path).text()

      for (const match of source.matchAll(/<form\b[^>]*>/g)) {
        const tag = match[0]
        const action = /\baction="([^"]*)"/.exec(tag)?.[1] ?? ''
        const method = (/\bmethod="([^"]*)"/.exec(tag)?.[1] ?? 'get').toLowerCase()

        found.push({ path, action, method })
      }
    }
  }

  return found
}

/** The routes this application declares, as the docs generator reads them. */
async function routes(): Promise<Set<string>> {
  const files = ['api.ts', 'v1.ts', 'users.ts', 'notifications.ts', 'attachments.ts']

  const sources = await Promise.all(files.map(async name => ({
    prefix: '/api',
    source: await Bun.file(`routes/${name}`).text().catch(() => ''),
  })))

  return pathsOf(declaredRoutes(sources))
}

describe('every form that changes something', () => {
  test('is actually found by this test, which is the part that fails silently', async () => {
    /*
     * A glob that matches nothing passes every assertion below it. This is the
     * cheapest guard against the whole file becoming decoration after somebody
     * moves a directory.
     */
    const forms = await formActions()

    expect(forms.length).toBeGreaterThan(30)
    expect(forms.filter(form => form.method === 'post').length).toBeGreaterThan(20)
    expect((await routes()).size).toBeGreaterThan(100)
  })

  test('posts to a route this application actually declares', async () => {
    const declared = await routes()
    const missing: string[] = []

    for (const form of await formActions()) {
      // A `get` form is a search or a filter: it changes nothing, and its
      // target is an ordinary page rather than an endpoint.
      if (form.method !== 'post')
        continue

      /*
       * An interpolated action is a component being told where to post by the
       * view that used it, and the view is where the literal lives. Following
       * the value would mean evaluating the template, which is a test that
       * tests the template engine.
       */
      if (!form.action.startsWith('/api/'))
        continue

      if (!declared.has(form.action))
        missing.push(`${form.path}: ${form.action}`)
    }

    expect(missing).toEqual([])
  })

  test('and posts to `/api`, rather than to a route of the screen\'s own', async () => {
    /*
     * The rule that keeps the two surfaces honest. Every state change the
     * interface can make is one a program can make, with the same permission
     * check, the same audit event and the same rate limit - because it is
     * literally the same action.
     *
     * The exceptions are the ones that are not endpoints at all: a form whose
     * target is interpolated by the view that used the component, and the
     * handful of page-level `post` targets that exist outside `/api` are none.
     */
    const elsewhere = (await formActions())
      .filter(form => form.method === 'post')
      .filter(form => form.action && !form.action.startsWith('/api/') && !form.action.includes('{{'))
      .map(form => `${form.path}: ${form.action}`)

    expect(elsewhere).toEqual([])
  })
})

/*
 * And the command line, which is the same rule with a different surface. It
 * had drifted: `ci:dispatch` posted to `/api/repos/workflow-dispatch`, and the
 * route is `/api/repos/workflows/dispatch` - a command that had been answering
 * 404 for anybody who ran it, because nothing here compared the two.
 */
describe('every path the command line calls', () => {
  test('is a route this application declares', async () => {
    const declared = await routes()
    const missing: string[] = []
    let seen = 0

    for await (const file of new Glob('*.ts').scan({ cwd: 'app/Commands' })) {
      const source = await Bun.file(`app/Commands/${file}`).text()

      /*
       * Both spellings a command uses: a bare literal, and a template string
       * carrying the query. The path is everything before the `?`, because a
       * route is declared without one.
       */
      for (const match of source.matchAll(/path:\s*[`']([^`'?]*\/api\/[^`'?]+)/g)) {
        const path = (match[1] ?? '').trim()

        if (!path.startsWith('/api/'))
          continue

        seen += 1

        if (!declared.has(path))
          missing.push(`app/Commands/${file}: ${path}`)
      }

      // And the ternary form, where one call chooses between two endpoints.
      for (const match of source.matchAll(/\?\s*'(\/api\/[^']+)'\s*:\s*'(\/api\/[^']+)'/g)) {
        for (const path of [match[1] ?? '', match[2] ?? '']) {
          seen += 1

          if (!declared.has(path))
            missing.push(`app/Commands/${file}: ${path}`)
        }
      }
    }

    // A regex that matches nothing passes the assertion below it.
    expect(seen).toBeGreaterThan(8)
    expect(missing).toEqual([])
  })
})
