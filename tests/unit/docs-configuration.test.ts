// The configuration reference: what it reads, and what it refuses to claim.
//
// The page exists because the hand-written one drifted. It documented
// `SEARCH_HOST` and `SEARCH_KEY` for Meilisearch months after the instance
// moved to Typesense, so anybody who followed it configured a search engine
// nothing reads. The tests below are mostly about the parsing that keeps this
// one honest: a comment attached to the wrong variable is the same failure in
// a new coat.

import { describe, expect, test } from 'bun:test'
import { checkedVariables, envReads, GIT_SET, groupOf, parseEnvExample, renderConfiguration } from '../../app/Docs/configuration'

const EXAMPLE = `APP_NAME=ReviewOS

# Signs and encrypts everything.
# Run \`buddy key:generate\`.
APP_KEY=

# The queue driver.
QUEUE_DRIVER=database

# Off unless set.
# SSO_ISSUER=
# SSO_CLIENT_ID=

DB_PASSWORD=
`

describe('reading .env.example', () => {
  const entries = parseEnvExample(EXAMPLE)

  test('every declaration is an entry, in the order the file declares them', () => {
    // The order is curated: somebody put the values you must set near the top
    // and grouped the database ones together. Sorting would scatter them.
    expect(entries.map(entry => entry.name)).toEqual([
      'APP_NAME',
      'APP_KEY',
      'QUEUE_DRIVER',
      'SSO_ISSUER',
      'SSO_CLIENT_ID',
      'DB_PASSWORD',
    ])
  })

  test('a comment block belongs to the variable under it, and to nothing else', () => {
    expect(entries[1]!.comment).toBe('Signs and encrypts everything.\nRun `buddy key:generate`.')
    expect(entries[0]!.comment).toBe('')
  })

  /*
   * The parse that matters. `# SSO_ISSUER=` is a variable, not prose - reading
   * it as a comment would swallow the declaration and glue the paragraph above
   * it onto whatever came next.
   */
  test('a commented-out assignment is a variable, not part of the comment above it', () => {
    const issuer = entries.find(entry => entry.name === 'SSO_ISSUER')!

    expect(issuer.optional).toBe(true)
    expect(issuer.comment).toBe('Off unless set.')
    expect(entries.find(entry => entry.name === 'SSO_CLIENT_ID')!.comment).toBe('')
  })

  test('and "unset" is a different fact from "empty"', () => {
    // `# VAPID_PUBLIC_KEY=` is a feature nobody turned on. `DB_PASSWORD=` is a
    // password that is genuinely blank.
    expect(entries.find(entry => entry.name === 'DB_PASSWORD')!.optional).toBe(false)
  })

  test('a blank line ends a paragraph, so comments do not accumulate', () => {
    const entries = parseEnvExample('# about nothing in particular\n\nPORT=3000\n')

    expect(entries[0]!.comment).toBe('')
  })
})

describe('who reads what', () => {
  test('all three ways the codebase spells it, with the file that does', () => {
    const reads = envReads([
      { path: 'app/One.ts', source: 'Bun.env.APP_KEY' },
      { path: 'app/Two.ts', source: 'process.env.APP_KEY; env.PORT' },
    ])

    expect(reads.get('APP_KEY')).toEqual(['app/One.ts', 'app/Two.ts'])
    expect(reads.get('PORT')).toEqual(['app/Two.ts'])
  })

  test('the boot check names its own variables, so the page marks them', () => {
    const checked = checkedVariables(`findings.push({ variable: 'APP_KEY', severity: 'fatal' })`)

    expect([...checked]).toEqual(['APP_KEY'])
  })

  test('and the variables git sets are known, because they are not yours to set', () => {
    // A value for one of these in `.env` is wrong for every repository but the
    // one it was copied from.
    expect(GIT_SET.has('GIT_DIR')).toBe(true)
    expect(GIT_SET.has('APP_KEY')).toBe(false)
  })
})

describe('the page', () => {
  const entries = parseEnvExample(EXAMPLE)
  const reads = envReads([{ path: 'app/Ops/config.ts', source: 'env.APP_KEY' }, { path: 'app/Late.ts', source: 'env.WEBHOOK_SIGNING_MODE' }])
  const page = renderConfiguration(entries, reads, 'from `.env.example`', new Set(['APP_KEY']))

  test('groups variables under the name a reader thinks in', () => {
    expect(groupOf('DB_HOST')).toBe('Database')
    expect(groupOf('DATABASE_URL')).toBe('Database')
    expect(page).toContain('## The application')
    expect(page).toContain('## The queue')
  })

  test('says where each one is read, and says so plainly when nothing does', () => {
    expect(page).toContain('Read by `app/Ops/config.ts`.')
    expect(page).toContain('this one is the framework\'s')
  })

  test('marks the ones a wrong value stops the instance over', () => {
    expect(page).toMatch(/`APP_KEY`[\s\S]*Checked at boot/)
  })

  /*
   * A variable readable only by grepping the source is undocumented, and the
   * page saying so is what gets the line into `.env.example`.
   */
  test('and lists what the code reads that the example never declared', () => {
    expect(page).toContain('## Read but not declared')
    expect(page).toContain('`WEBHOOK_SIGNING_MODE`, read by `app/Late.ts`')
  })
})

describe('the committed page', () => {
  /*
   * The drift check, the same one `buddy docs:reference --check` runs. A page
   * generated by a command nobody runs is a hand-written page with extra steps.
   */
  test('is what the generator produces today', async () => {
    const { Glob } = await import('bun')
    const readers: Array<{ path: string, source: string }> = []

    for (const directory of ['app', 'routes']) {
      for await (const file of new Glob('**/*.ts').scan({ cwd: directory }))
        readers.push({ path: `${directory}/${file}`, source: await Bun.file(`${directory}/${file}`).text() })
    }

    readers.sort((left, right) => left.path.localeCompare(right.path))

    const body = renderConfiguration(
      parseEnvExample(await Bun.file('.env.example').text()),
      envReads(readers),
      'from `.env.example` and the source that reads it',
      checkedVariables(await Bun.file('app/Ops/config.ts').text()),
    )

    expect(await Bun.file('docs/configuration.md').text()).toBe(body)
  })

  test('declares every variable this application reads', async () => {
    // The section above exists to be empty. When it is not, the fix is a line
    // in `.env.example` with a sentence saying what the variable is for.
    const committed = await Bun.file('docs/configuration.md').text()

    expect(committed).not.toContain('## Read but not declared')
  })

  test('and the self-hosting guide points at it rather than repeating it', async () => {
    const guide = await Bun.file('docs/self-hosting.md').text()

    expect(guide).toContain('](./configuration.md)')
    // The drift that started this: a row for Meilisearch, long after the
    // instance moved to Typesense. The guide still tells the story, so this
    // looks for the row rather than the name.
    expect(guide).not.toContain('| `SEARCH_HOST`')
    expect(guide).toContain('| `TYPESENSE_HOST`')
  })
})
