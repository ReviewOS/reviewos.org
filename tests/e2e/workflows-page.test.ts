// The workflows screen: what is registered, and why anything that will not run
// does not.
//
// Asked of the rendered page rather than of the helpers behind it, because stx
// fails silently: a server script that throws renders the template with every
// variable undefined, so a broken query here produces a page listing no
// workflows - which reads as a repository that has none.
//
// The half that matters is the dispatch form. It is generated from the inputs
// the workflow declared, and each of Actions' four input types gets a different
// control: a text field, a select over the declared options, a true/false
// select, and a select over this repository's environments. A form that offered
// a free text box for a protected environment is a deploy that silently goes
// somewhere else.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  ownerToken: '',
  outsiderToken: '',
  repositoryId: 0,
  handle: '',
  name: '',
}

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The page as a reader receives it, optionally signed in. */
async function page(token?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/workflows`, {
    headers: { Accept: 'text/html', ...(token ? { Cookie: `auth-token=${token}` } : {}) },
  })

  return await answer.text()
}

/** A workflow and its newest version, in whatever state the test needs. */
async function workflow(input: {
  path: string
  name: string
  state?: string
  version?: Record<string, unknown> | null
}): Promise<void> {
  const row: any = await db.insertInto('workflows').values({
    owner_type: 'user',
    owner_id: created.ownerId,
    repository_id: created.repositoryId,
    path: input.path,
    name: input.name,
    state: input.state ?? 'active',
  }).returning(['id']).executeTakeFirst()

  if (input.version === null)
    return

  await db.insertInto('workflow_versions').values({
    workflow_id: Number(row.id),
    source_sha: 'a'.repeat(40),
    source_path: input.path,
    content_digest: unique('d').padEnd(64, '0').slice(0, 64),
    ...input.version,
  } as any).execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string) => {
      const handle = unique(prefix)
      const row: any = await db.insertInto('users')
        .values({ name: 'Workflows Reader', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id']).executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'workflows page test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('wfo')
    const outsider = await make('wfx')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.ownerToken = owner.token
    created.outsiderToken = outsider.token
    created.name = unique('wrepo')

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    await db.insertInto('environments').values({
      repository_id: created.repositoryId,
      name: 'production',
    } as any).execute()

    await db.insertInto('environments').values({
      repository_id: created.repositoryId,
      name: 'staging',
    } as any).execute()

    /*
     * Four workflows, one per way of being invisible on the runs list: one that
     * runs, one whose file is gone, one somebody switched off, and one whose
     * only trigger is an event this instance recognises and does not dispatch.
     */
    await workflow({
      path: '.github/workflows/release.yml',
      name: 'Release',
      version: {
        on_push: true,
        on_dispatch: true,
        dispatch_inputs: JSON.stringify([
          { name: 'version', type: 'string', description: 'what to call it', required: true, default: '1.0.0', options: [] },
          { name: 'channel', type: 'choice', description: '', required: false, default: 'stable', options: ['stable', 'beta'] },
          { name: 'dry_run', type: 'boolean', description: '', required: false, default: 'true', options: [] },
          { name: 'target', type: 'environment', description: '', required: false, default: 'staging', options: [] },
        ]),
      },
    })

    await workflow({ path: '.github/workflows/gone.yml', name: 'Gone', state: 'removed', version: { on_push: true } })
    await workflow({ path: '.github/workflows/off.yml', name: 'Switched off', state: 'disabled', version: { on_push: true } })
    await workflow({
      path: '.github/workflows/watched.yml',
      name: 'Watched',
      version: { unsupported_events: 'watch\ngollum' },
    })

    available = true
  }
  catch (error) {
    console.warn(`[workflows-page] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.(true)

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('the workflows page', () => {
  test('lists what is registered and what each fires on', async () => {
    if (!available)
      return

    const html = await page()

    expect(html).toContain('Release')
    expect(html).toContain('.github/workflows/release.yml')
    expect(html).toContain('Runs on push, manual')
  })

  test('offers the badge as a line to paste, pointing at this instance', async () => {
    if (!available)
      return

    const html = await page()

    // The snippet and the picture it produces, both relative: a badge carrying
    // somebody else's hostname is the one bug here nobody notices until the
    // README is public.
    expect(html).toContain('/api/repos/badge?owner=')
    expect(html).toContain('workflow=.github%2Fworkflows%2Frelease.yml')
    expect(html).toContain('![Release](')
    expect(html).not.toContain('https://reviewos.org/api/repos/badge')
  })

  test('says why a workflow will never run, in words', async () => {
    if (!available)
      return

    const html = await page()

    // The four cases that are indistinguishable from the runs list, which shows
    // nothing for every one of them.
    expect(html).toContain('no longer on the default branch')
    expect(html).toContain('Somebody switched this workflow off')
    expect(html).toContain('watch, gollum')
    expect(html).toContain('None of its triggers start a run')
  })

  test('generates a control per input type for whoever may run it', async () => {
    if (!available)
      return

    const html = await page(created.ownerToken)

    // Posted to the same public action the API and the CLI call: a control the
    // interface has and the API does not is a second, undocumented way to
    // change the instance's state.
    expect(html).toContain('/api/repos/workflows/dispatch')

    // A string is a text field carrying its default.
    expect(html).toContain('name="inputs[version]"')
    expect(html).toContain('value="1.0.0"')

    // A choice is a select over exactly the options declared.
    expect(html).toContain('name="inputs[channel]"')
    expect(html).toContain('<option value="beta"')

    // A boolean is true/false rather than a text box somebody types `yes` into.
    expect(html).toContain('name="inputs[dry_run]"')

    /*
     * And an environment is a select over the repository's own environments.
     * Actions' fourth type exists because typing the name of a protected
     * environment wrong is a deploy that silently goes somewhere else.
     */
    expect(html).toContain('name="inputs[target]"')
    expect(html).toContain('<option value="production"')
    expect(html).toContain('<option value="staging"')
  })

  test('offers no form to a reader who may not spend the instance\'s runners', async () => {
    if (!available)
      return

    const html = await page(created.outsiderToken)

    // Still readable - the page is the answer to "why did nothing happen" and
    // that is not privileged - but starting a run is not on offer.
    expect(html).toContain('Release')
    expect(html).not.toContain('/api/repos/workflows/dispatch')
  })

  test('and never an em dash, which is the house rule for anything a person reads', async () => {
    if (!available)
      return

    /*
     * Checked here because this page renders a line per behavioural difference,
     * and that line joined a key to its message with one. A rule nothing tests
     * is a rule that comes back.
     *
     * Script and style are cut out first, and the reason is not fastidiousness:
     * stx injects its own client runtime into every page, and one of its
     * comments reads "Make state reactive — mutations trigger re-render via
     * signals". So this failed on every page in the product regardless of what
     * this one said, and it failed in CI while passing nowhere anybody looked -
     * a copy rule that fires on a vendor comment is a copy rule people learn to
     * ignore. The house rule is about what a person reads, and nobody reads
     * that.
     */
    const html = await page(created.ownerToken)
    const body = html
      .slice(html.indexOf('<body'))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')

    expect(body.includes('—')).toBe(false)
  })
})
