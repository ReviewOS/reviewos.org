import type { CLI } from '@stacksjs/types'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import, and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { initBare } from '../Actions/Git/git'
import { repositoryPath } from '../Actions/Git/storage'
import { branchSha, createCommit } from '../Actions/Git/write'
import { DEFAULT_LABELS } from '../Actions/Issue/labels'

/**
 * A demonstration repository with a real pull request in it.
 *
 * The model factories seed rows, which is right for most things and wrong for
 * this one: a pull request row records a `head_sha` and a `base_sha`, and if
 * there is no repository on disk holding those commits then the review screen,
 * which is the whole point of the product, renders an empty diff. It looked like
 * a bug in the diff loader for a while. It was seeded data with nothing behind
 * it.
 *
 * So this writes the commits first and takes the shas from git, rather than
 * inventing them and hoping.
 *
 * Idempotent: run it twice and it reports what already exists rather than
 * failing or duplicating.
 */

const OWNER_FALLBACK = 'demo'
const REPOSITORY = 'checkout'

interface SeedOptions {
  owner?: string
}

export default function (cli: CLI) {
  cli
    .command('seed:demo', 'Create a demonstration repository with a real pull request')
    .option('--owner <handle>', 'The user handle to own it', { default: '' })
    .action(async (options: SeedOptions) => {
      try {
        await seed(options.owner ?? '')
        process.exit(0)
      }
      catch (error) {
        // `console.error` rather than the logger: the logger writes
        // asynchronously and `process.exit` below can beat it to the terminal,
        // which turns a failure into a silent exit code 1.
        console.error('Could not seed the demonstration repository:')
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        process.exit(1)
      }
    })
}

async function seed(requestedOwner: string): Promise<void> {
  const owner = await resolveOwner(requestedOwner)
  console.log(`Seeding as ${owner.handle}`)

  const resolved = repositoryPath(owner.handle, REPOSITORY)
  if (!resolved.ok)
    throw new Error('The demonstration repository name did not resolve to a safe path')

  const existing = await db
    .selectFrom('repositories')
    .select(['id'])
    .where('owner_type', '=', 'user')
    .where('owner_id', '=', owner.id)
    .where('name', '=', REPOSITORY)
    .executeTakeFirst()

  let repositoryId: number

  if (existing) {
    repositoryId = Number(existing.id)
    console.log(`Repository ${owner.handle}/${REPOSITORY} already exists, reusing it`)
  }
  else {
    const created = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: owner.id,
        name: REPOSITORY,
        description: 'A demonstration repository with a pull request worth reviewing',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    repositoryId = Number(created?.id)

    await db
      .insertInto('repository_labels')
      .values(DEFAULT_LABELS.map(label => ({
        repository_id: repositoryId,
        name: label.name,
        color: label.color,
        description: label.description,
        is_default: true,
      })))
      .execute()
  }

  await mkdir(dirname(resolved.path!), { recursive: true })

  if (await branchSha(resolved.path!, 'main') === null) {
    const init = await initBare(resolved.path!, 'main')
    if (!init.ok && !init.stderr.includes('already exists'))
      throw new Error(`git init failed: ${init.stderr}`)
  }

  const author = { name: owner.name, email: owner.email }
  const path = resolved.path!

  // Two commits on main, so the branch has somewhere to diverge from and the
  // merge base is not simply the root commit.
  let head = await branchSha(path, 'main')

  if (head === null) {
    head = await commit(path, {
      branch: 'main',
      parentSha: null,
      expectedBranchSha: null,
      message: 'Add the cart total',
      author,
      files: {
        'README.md': README,
        'src/cart.ts': CART_BEFORE,
        'src/money.ts': MONEY,
      },
    })

    head = await commit(path, {
      branch: 'main',
      parentSha: head,
      message: 'Document the rounding rule',
      author,
      files: { 'docs/pricing.md': PRICING_DOCS },
    })
  }

  const baseSha = head

  // Three commits on the branch, each doing one thing, so the review has
  // something to read commit by commit rather than one shapeless diff.
  let branchHead = await branchSha(path, 'fix/rounding')

  if (branchHead === null) {
    branchHead = await commit(path, {
      branch: 'fix/rounding',
      parentSha: baseSha,
      expectedBranchSha: null,
      message: 'Round each line rather than the total',
      author,
      files: { 'src/cart.ts': CART_AFTER },
    })

    branchHead = await commit(path, {
      branch: 'fix/rounding',
      parentSha: branchHead,
      message: 'Cover the half-cent case',
      author,
      files: { 'tests/cart.test.ts': CART_TEST },
    })

    branchHead = await commit(path, {
      branch: 'fix/rounding',
      parentSha: branchHead,
      message: 'Say which way a half rounds',
      author,
      files: { 'docs/pricing.md': PRICING_DOCS_AFTER },
    })
  }

  const openPullRequest = await db
    .selectFrom('pull_requests')
    .select(['id', 'number'])
    .where('repository_id', '=', repositoryId)
    .where('head_branch', '=', 'fix/rounding')
    .executeTakeFirst()

  if (openPullRequest) {
    console.log(`Pull request #${openPullRequest.number} already exists at /${owner.handle}/${REPOSITORY}/pull/${openPullRequest.number}`)
    return
  }

  const counter = await db
    .selectFrom('repositories')
    .select(['issue_counter'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()

  const number = Number(counter?.issue_counter ?? 0) + 1

  await db
    .updateTable('repositories')
    .set({ issue_counter: number })
    .where('id', '=', repositoryId)
    .execute()

  await db
    .insertInto('pull_requests')
    .values({
      repository_id: repositoryId,
      number,
      title: 'Round each line rather than the total',
      body: PULL_REQUEST_BODY,
      author_id: owner.id,
      state: 'open',
      head_repository_id: repositoryId,
      head_branch: 'fix/rounding',
      head_sha: branchHead,
      base_branch: 'main',
      base_sha: baseSha,
      draft: false,
      mergeable_state: 'unknown',
      stack_parent_id: null,
      additions: 0,
      deletions: 0,
      changed_files: 3,
    })
    .execute()

  console.log(`Seeded /${owner.handle}/${REPOSITORY}/pull/${number} with a real diff behind it`)
}

/** Write a commit, or fail loudly. A half-seeded repository is worse than none. */
async function commit(path: string, input: Parameters<typeof createCommit>[1]): Promise<string> {
  const result = await createCommit(path, input)

  if (!result.ok)
    throw new Error(`${input.message}: ${result.error}`)

  return result.sha
}

/** The user to seed under: the one named, else the first, else a new one. */
async function resolveOwner(requested: string): Promise<{ id: number, handle: string, name: string, email: string }> {
  if (requested) {
    const named = await db
      .selectFrom('users')
      .select(['id', 'handle', 'name', 'email'])
      .where('handle', '=', requested.toLowerCase())
      .executeTakeFirst()

    if (!named)
      throw new Error(`There is no user with the handle ${requested}`)

    return asOwner(named)
  }

  const first = await db
    .selectFrom('users')
    .select(['id', 'handle', 'name', 'email'])
    .executeTakeFirst()

  if (first)
    return asOwner(first)

  const created = await db
    .insertInto('users')
    .values({
      handle: OWNER_FALLBACK,
      name: 'Demo User',
      email: 'demo@example.com',
    })
    .returning(['id'])
    .executeTakeFirst()

  return {
    id: Number(created?.id),
    handle: OWNER_FALLBACK,
    name: 'Demo User',
    email: 'demo@example.com',
  }
}

function asOwner(row: any) {
  return {
    id: Number(row.id),
    handle: String(row.handle),
    name: String(row.name ?? row.handle),
    email: String(row.email ?? `${row.handle}@example.com`),
  }
}

const README = `# checkout

The pricing and cart logic, extracted so it can be tested without a checkout
flow around it.
`

const MONEY = `/** Money is integer cents everywhere. Floats do not survive a tax rate. */
export function cents(amount: number): number {
  return Math.round(amount * 100)
}

export function format(value: number): string {
  return \`$\${(value / 100).toFixed(2)}\`
}
`

const CART_BEFORE = `import { cents } from './money'

export interface Line {
  name: string
  unitPrice: number
  quantity: number
  taxRate: number
}

/**
 * The total for a cart.
 *
 * Tax is applied to the sum and rounded once at the end.
 */
export function total(lines: Line[]): number {
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)
  const tax = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity * line.taxRate, 0)

  return cents((subtotal + tax) / 100)
}
`

const CART_AFTER = `import { cents } from './money'

export interface Line {
  name: string
  unitPrice: number
  quantity: number
  taxRate: number
}

/**
 * The total for a cart.
 *
 * Tax is applied and rounded per line, not once at the end. Rounding the sum
 * makes the total disagree with the receipt beside it, because the receipt
 * shows each line rounded and a reader adds those up.
 */
export function total(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0)
}

/** One line, tax included, rounded to the cent. */
export function lineTotal(line: Line): number {
  const net = line.unitPrice * line.quantity

  return cents((net + net * line.taxRate) / 100)
}
`

const CART_TEST = `import { describe, expect, test } from 'bun:test'
import { lineTotal, total } from '../src/cart'

describe('total', () => {
  test('rounds each line rather than the sum', () => {
    // Three lines that each land on a half cent. Rounded once at the end this
    // came to 302; rounded per line it is 303, which is what the receipt says.
    const lines = Array.from({ length: 3 }, () => ({
      name: 'Widget',
      unitPrice: 95,
      quantity: 1,
      taxRate: 0.055,
    }))

    expect(total(lines)).toBe(303)
  })

  test('a single line is its own total', () => {
    const line = { name: 'Widget', unitPrice: 100, quantity: 2, taxRate: 0.1 }

    expect(total([line])).toBe(lineTotal(line))
  })

  test('an empty cart is free', () => {
    expect(total([])).toBe(0)
  })
})
`

const PRICING_DOCS = `# Pricing

Money is integer cents throughout. A float survives one multiplication and not
two, and a tax rate is the second one.
`

const PRICING_DOCS_AFTER = `# Pricing

Money is integer cents throughout. A float survives one multiplication and not
two, and a tax rate is the second one.

## Rounding

Each line is rounded to the cent with tax included, and the total is the sum of
the rounded lines. A half rounds up.

The alternative, rounding once at the end, makes the total disagree with the
receipt printed beside it: the receipt shows rounded lines, and anybody adding
them up gets a different answer from the one they were charged.
`

const PULL_REQUEST_BODY = `Rounding once at the end made the total disagree with the receipt beside it. The
receipt shows each line rounded, so a customer adding the lines up got a
different number from the one they were charged, by a cent or two on a large
order.

Each line is now rounded with its tax included and the total is the sum of those.

- \`lineTotal\` is exported so the receipt renderer can use exactly the same
  rounding rather than repeating it
- The test covers three lines that each land on a half cent, which is the case
  that produced the original report
`
