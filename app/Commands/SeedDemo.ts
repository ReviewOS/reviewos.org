import type { CLI } from '@stacksjs/types'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import, and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import {
  CART_AFTER,
  CART_BEFORE,
  CART_TEST,
  MONEY,
  PRICING_DOCS,
  PRICING_DOCS_AFTER,
  PULL_REQUEST_BODY,
  README,
  RETRY_BODY,
  REVIEW_APPROVING,
  REVIEW_ASKING,
  SENDER_BEFORE,
  SENDER_RETRY,
  SENDER_TIMEOUT,
  SERVICE_README,
  SERVICE_TYPES,
  TIMEOUT_BODY,
} from './demo-content'
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
  instance?: boolean
}

/**
 * The people a believable instance has on it.
 *
 * Four, which is the smallest number that produces the situations worth
 * looking at: an author, a reviewer who has asked for a change, a reviewer who
 * has approved, and somebody who has been asked and has not answered. Three
 * cannot show all four states at once and five adds nothing a page renders
 * differently.
 */
const CAST = [
  { handle: 'ada', name: 'Ada Okonkwo', email: 'ada@example.com' },
  { handle: 'rowan', name: 'Rowan Vasquez', email: 'rowan@example.com' },
  { handle: 'mira', name: 'Mira Lindqvist', email: 'mira@example.com' },
  { handle: 'theo', name: 'Theo Bergmann', email: 'theo@example.com' },
] as const

const ORGANIZATION = 'northwind'
const SERVICE = 'notify'

export default function (cli: CLI) {
  cli
    .command('seed:demo', 'Create a demonstration repository with a real pull request')
    .option('--owner <handle>', 'The user handle to own it', { default: '' })
    /*
     * The whole instance rather than the one repository.
     *
     * Off by default because the single-repository seed is what somebody
     * demonstrating the review screen wants, and it takes a second. The
     * instance seed is for developing *against* - the review queue, the
     * organization pages, the stack view - and those need more than one
     * repository to be worth looking at.
     */
    .option('--instance', 'Also seed an organization, a cast of people, and a queue of work', { default: false })
    .action(async (options: SeedOptions) => {
      try {
        await seed(options.owner ?? '')

        if (options.instance)
          await seedInstance()
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


/**
 * An organization, a cast, and a queue of work in several states.
 *
 * The single-repository seed above demonstrates the review screen. This
 * demonstrates the *instance*: a review queue with things in it, an
 * organization with members, and a stack of dependent pull requests - which is
 * the case this product exists for and the one that is hardest to fake
 * convincingly, because the second pull request has to actually branch off the
 * first.
 *
 * Idempotent, like the seed above. Run it twice and it says what already exists
 * rather than duplicating anything: a developer runs this after every
 * `migrate:fresh` and sometimes twice by accident.
 */
async function seedInstance(): Promise<void> {
  console.log('')
  console.log('Seeding an instance:')

  const people: Record<string, { id: number, handle: string, name: string, email: string }> = {}

  for (const person of CAST)
    people[person.handle] = await ensurePerson(person)

  const organizationId = await ensureOrganization(people)
  const author = people.ada!
  const path = await ensureServiceRepository(organizationId)
  const repositoryId = path.repositoryId

  /*
   * A base with history, then two branches where the second is built on the
   * first. That last part is what makes it a stack rather than two unrelated
   * pull requests, and it is the thing a hand-written fixture always gets
   * wrong - the diff of the second one has to be *only* its own change.
   */
  let main = await branchSha(path.disk, 'main')

  if (main === null) {
    main = await commit(path.disk, {
      branch: 'main',
      parentSha: null,
      expectedBranchSha: null,
      message: 'Send a message to an endpoint',
      author: { name: author.name, email: author.email },
      files: {
        'README.md': SERVICE_README,
        'src/sender.ts': SENDER_BEFORE,
        'src/types.ts': SERVICE_TYPES,
      },
    })
  }

  const base = main

  let timeoutHead = await branchSha(path.disk, 'add-timeout')

  if (timeoutHead === null) {
    timeoutHead = await commit(path.disk, {
      branch: 'add-timeout',
      parentSha: base,
      expectedBranchSha: null,
      message: 'Give a receiver a deadline',
      author: { name: author.name, email: author.email },
      files: { 'src/sender.ts': SENDER_TIMEOUT },
    })
  }

  let retryHead = await branchSha(path.disk, 'add-retry')

  if (retryHead === null) {
    retryHead = await commit(path.disk, {
      // Off the *timeout* branch, not off main. Without this the second pull
      // request's diff contains the first one's change as well, which is
      // exactly the mess a stack exists to avoid and exactly what a fixture
      // built off main would demonstrate.
      branch: 'add-retry',
      parentSha: timeoutHead,
      expectedBranchSha: null,
      message: 'Try a few times, backing off',
      author: { name: author.name, email: author.email },
      files: { 'src/sender.ts': SENDER_RETRY },
    })
  }

  const timeout = await ensurePullRequest({
    repositoryId,
    branch: 'add-timeout',
    title: 'Give a receiver a deadline',
    body: TIMEOUT_BODY,
    authorId: author.id,
    headSha: timeoutHead,
    baseBranch: 'main',
    baseSha: base,
    stackParentId: null,
  })

  const retry = await ensurePullRequest({
    repositoryId,
    branch: 'add-retry',
    title: 'Try a few times, backing off',
    body: RETRY_BODY,
    authorId: author.id,
    headSha: retryHead,
    // Based on the branch below it, which is what makes the stack real rather
    // than a label.
    baseBranch: 'add-timeout',
    baseSha: timeoutHead,
    stackParentId: timeout.id,
  })

  /*
   * The four states worth seeing on one page.
   *
   * Somebody opening the review queue should find work waiting on them, work
   * they have answered, and work somebody else has not - because that is what
   * the queue is for, and it is the only way to tell whether the ordering and
   * the empty states are right.
   */
  await ensureReview(timeout.id, people.rowan!.id, 'changes_requested', REVIEW_ASKING, timeoutHead)
  await ensureReview(retry.id, people.mira!.id, 'approved', REVIEW_APPROVING, retryHead)
  await ensureReviewRequest(timeout.id, people.theo!.id, author.id)
  await ensureReviewRequest(retry.id, people.theo!.id, author.id)

  console.log(`  ${ORGANIZATION}/${SERVICE} with a stack of two`)
  console.log(`    #${timeout.number} changes requested by rowan, waiting on theo`)
  console.log(`    #${retry.number} approved by mira, waiting on theo, stacked on #${timeout.number}`)
  console.log('')
  console.log(`  Sign in as any of: ${CAST.map(one => `${one.email}`).join(', ')}`)
  console.log(`  Password for all of them: ${DEMO_PASSWORD}`)
}

/** A person, made if they are not there. */
async function ensurePerson(person: { handle: string, name: string, email: string }) {
  const existing = await db
    .selectFrom('users')
    .select(['id', 'handle', 'name', 'email'])
    .where('handle', '=', person.handle)
    .executeTakeFirst()

  if (existing) {
    /*
     * The password is refreshed, but only on an account that is unmistakably
     * one of these.
     *
     * A developer who ran an earlier version of this seed has four accounts
     * they cannot sign in as, and re-running the seed should fix that rather
     * than report success. Matching on the *email* as well as the handle is
     * what makes that safe: somebody whose own account happens to be called
     * `ada` does not get their password reset by a demo command.
     */
    if (String(existing.email ?? '') === person.email) {
      await db
        .updateTable('users')
        .set({ password: await hashDemoPassword() })
        .where('id', '=', Number(existing.id))
        .execute()
    }

    return asOwner(existing)
  }

  /*
   * A known password, and it is a development seed saying so out loud.
   *
   * `password` is not null on `users`, so a seeded account needs one - and a
   * random one would produce four accounts nobody can sign in as, which defeats
   * the point of a cast. The value is printed at the end for the same reason.
   * Nothing here should ever run against an instance anybody uses, which is why
   * the command is called `seed:demo`.
   */
  const created = await db
    .insertInto('users')
    .values({
      handle: person.handle,
      name: person.name,
      email: person.email,
      password: await hashDemoPassword(),
    })
    .returning(['id'])
    .executeTakeFirst()

  return { id: Number(created?.id), ...person }
}

/** The password every seeded account shares, hashed the way sign-in expects. */
export const DEMO_PASSWORD = 'demo-password-not-a-secret'

async function hashDemoPassword(): Promise<string> {
  // `makeHash` with bcrypt, which is exactly what `RegisterAction` writes. A
  // seed that hashed differently would produce accounts that exist, look right,
  // and cannot sign in - and the symptom would read as a broken sign-in rather
  // than a broken fixture.
  const { makeHash } = await import('@stacksjs/security')

  return await makeHash(DEMO_PASSWORD, { algorithm: 'bcrypt' })
}

/** The organization, with everybody in it and one of them running it. */
async function ensureOrganization(people: Record<string, { id: number }>): Promise<number> {
  const existing = await db
    .selectFrom('organizations')
    .select(['id'])
    .where('handle', '=', ORGANIZATION)
    .executeTakeFirst()

  const organizationId = existing
    ? Number(existing.id)
    : Number((await db
        .insertInto('organizations')
        .values({ handle: ORGANIZATION, name: 'Northwind', description: 'The demonstration organization' })
        .returning(['id'])
        .executeTakeFirst())?.id)

  for (const [handle, person] of Object.entries(people)) {
    const member = await db
      .selectFrom('org_members')
      .select(['id'])
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', person.id)
      .executeTakeFirst()

    if (member)
      continue

    await db.insertInto('org_members').values({
      organization_id: organizationId,
      user_id: person.id,
      // One owner and three members, which is the ordinary shape. An
      // organization where everybody is an owner demonstrates nothing about
      // permissions, and permissions are half of what an organization is.
      role: handle === 'ada' ? 'owner' : 'member',
      joined_at: new Date().toISOString(),
    }).execute()
  }

  return organizationId
}

/** The service repository, on disk and in the database. */
async function ensureServiceRepository(organizationId: number): Promise<{ repositoryId: number, disk: string }> {
  const resolved = repositoryPath(ORGANIZATION, SERVICE)

  if (!resolved.ok)
    throw new Error('The service repository name did not resolve to a safe path')

  const existing = await db
    .selectFrom('repositories')
    .select(['id'])
    .where('owner_type', '=', 'organization')
    .where('owner_id', '=', organizationId)
    .where('name', '=', SERVICE)
    .executeTakeFirst()

  const repositoryId = existing
    ? Number(existing.id)
    : Number((await db
        .insertInto('repositories')
        .values({
          owner_type: 'organization',
          owner_id: organizationId,
          name: SERVICE,
          description: 'Sending things to people, with a stack of changes in flight',
          visibility: 'public',
          default_branch: 'main',
          disk_path: resolved.relative!,
        })
        .returning(['id'])
        .executeTakeFirst())?.id)

  await mkdir(dirname(resolved.path!), { recursive: true })

  if (await branchSha(resolved.path!, 'main') === null) {
    const init = await initBare(resolved.path!, 'main')

    if (!init.ok && !init.stderr.includes('already exists'))
      throw new Error(`git init failed: ${init.stderr}`)
  }

  return { repositoryId, disk: resolved.path! }
}

interface PullRequestSeed {
  repositoryId: number
  branch: string
  title: string
  body: string
  authorId: number
  headSha: string
  baseBranch: string
  baseSha: string
  stackParentId: number | null
}

/** A pull request, made if the branch does not already have one. */
async function ensurePullRequest(seed: PullRequestSeed): Promise<{ id: number, number: number }> {
  const existing = await db
    .selectFrom('pull_requests')
    .select(['id', 'number'])
    .where('repository_id', '=', seed.repositoryId)
    .where('head_branch', '=', seed.branch)
    .executeTakeFirst()

  if (existing)
    return { id: Number(existing.id), number: Number(existing.number) }

  const counter = await db
    .selectFrom('repositories')
    .select(['issue_counter'])
    .where('id', '=', seed.repositoryId)
    .executeTakeFirst()

  const number = Number(counter?.issue_counter ?? 0) + 1

  await db
    .updateTable('repositories')
    .set({ issue_counter: number })
    .where('id', '=', seed.repositoryId)
    .execute()

  const created = await db
    .insertInto('pull_requests')
    .values({
      repository_id: seed.repositoryId,
      number,
      title: seed.title,
      body: seed.body,
      author_id: seed.authorId,
      state: 'open',
      head_repository_id: seed.repositoryId,
      head_branch: seed.branch,
      head_sha: seed.headSha,
      base_branch: seed.baseBranch,
      base_sha: seed.baseSha,
      draft: false,
      mergeable_state: 'unknown',
      stack_parent_id: seed.stackParentId,
      additions: 0,
      deletions: 0,
      changed_files: 1,
    })
    .returning(['id'])
    .executeTakeFirst()

  return { id: Number(created?.id), number }
}

/** A submitted review, made if this person has not reviewed already. */
async function ensureReview(
  pullRequestId: number,
  reviewerId: number,
  state: string,
  body: string,
  commitSha: string,
): Promise<void> {
  const existing = await db
    .selectFrom('pull_request_reviews')
    .select(['id'])
    .where('pull_request_id', '=', pullRequestId)
    .where('reviewer_id', '=', reviewerId)
    .executeTakeFirst()

  if (existing)
    return

  await db.insertInto('pull_request_reviews').values({
    pull_request_id: pullRequestId,
    reviewer_id: reviewerId,
    state,
    body,
    commit_sha: commitSha,
    submitted_at: new Date().toISOString(),
  }).execute()
}

/** A request nobody has answered, which is what a review queue is made of. */
async function ensureReviewRequest(pullRequestId: number, reviewerId: number, requestedById: number): Promise<void> {
  const existing = await db
    .selectFrom('pull_request_reviewers')
    .select(['id'])
    .where('pull_request_id', '=', pullRequestId)
    .where('reviewer_type', '=', 'user')
    .where('reviewer_id', '=', reviewerId)
    .executeTakeFirst()

  if (existing)
    return

  await db.insertInto('pull_request_reviewers').values({
    pull_request_id: pullRequestId,
    reviewer_type: 'user',
    reviewer_id: reviewerId,
    requested_by_id: requestedById,
    from_code_owners: false,
    responded_at: null,
  }).execute()
}
