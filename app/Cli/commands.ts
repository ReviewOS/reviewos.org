/**
 * What the CLI actually does, separated from how it is invoked.
 *
 * Each function prints for a person and returns an exit code. Nothing here
 * calls `process.exit`, which is the whole reason it is a separate file: a
 * command that exits the process cannot be tested, so the version that can be
 * tested is the one with the logic in it.
 *
 * Two front ends call these - the `buddy` registration for working inside this
 * repository, and the standalone `reviewos` binary a contributor installs.
 * Neither has any behaviour of its own beyond parsing arguments.
 *
 * **Everything here goes over HTTP to the public API.** Nothing imports a model
 * or touches the database, and that constraint is the point rather than a
 * detail: it is what turned "the CLI needs to list pull requests" into an
 * endpoint that exists for everybody, instead of a query only the CLI has.
 */

import process from 'node:process'
import { call, report } from './api'
import { git, standing } from './context'
import { keychainFor, tokenFor } from './keychain'

export interface LoginOptions { token?: string, instance?: string }
export interface OpenOptions { title?: string, body?: string, base?: string, draft?: boolean }
export interface ListOptions { state?: string, author?: string }
export interface StackOptions { number?: string }
export interface ReviewOptions { approve?: boolean, requestChanges?: boolean, file?: string }

export async function login(options: LoginOptions = {}): Promise<number> {
  const where = await instanceFor(options.instance)
  if (!where)
    return 1

  const keychain = keychainFor()

  const token = String(options.token ?? '').trim() || await prompt('Access token: ')
  if (!token) {
    console.error('No token given.')
    return 1
  }

  // Checked before it is stored. Storing a token that does not work and
  // discovering it on the next command is a worse first experience than one
  // extra round trip.
  const who = await call({ instance: where, token }, 'GET', '/api/user')
  if (!who.ok)
    return report(who)

  if (!await keychain.write(where, token)) {
    console.error(`Could not write to ${keychain.describe()}.`)
    console.error('Set REVIEWOS_TOKEN in the environment instead - that is what CI does.')
    return 1
  }

  console.log(`Signed in to ${where} as ${who.data?.handle ?? 'somebody'}, stored in ${keychain.describe()}.`)

  return 0
}

export async function logout(options: { instance?: string } = {}): Promise<number> {
  const where = await instanceFor(options.instance)
  if (!where)
    return 1

  const keychain = keychainFor()
  const erased = await keychain.erase(where)

  console.log(erased ? `Forgot the token for ${where}.` : `No token stored for ${where}.`)

  return 0
}

export async function whoami(options: { instance?: string } = {}): Promise<number> {
  const where = await instanceFor(options.instance)
  if (!where)
    return 1

  const who = await call({ instance: where, token: await tokenFor(where) }, 'GET', '/api/user')
  if (!who.ok)
    return report(who)

  console.log(`${who.data?.handle ?? 'somebody'} at ${where}`)

  return 0
}

export async function openPullRequest(options: OpenOptions = {}): Promise<number> {
  const here = await standing()
  if (!here)
    return notInACheckout()

  if (!here.branch) {
    console.error('You are not on a branch.')
    console.error('Check one out first: a pull request is a request to merge one.')

    return 1
  }

  const connection = { instance: here.instance, token: await tokenFor(here.instance) }

  /*
   * The last commit's subject, when no title was given. It is what the author
   * already wrote about this change, and asking them to write it again in a
   * flag is how titles end up as "wip".
   */
  const title = String(options.title ?? '').trim() || await git('log', '-1', '--pretty=%s') || here.branch

  const opened = await call(connection, 'POST', '/api/repos/pulls', {
    body: {
      owner: here.owner,
      repo: here.repository,
      title,
      body: options.body ?? '',
      head: here.branch,
      base: options.base,
      draft: Boolean(options.draft),
    },
  })

  if (!opened.ok)
    return report(opened)

  const number = opened.data?.number
  console.log(`Opened #${number}: ${title}`)
  console.log(`${here.instance}/${here.owner}/${here.repository}/pull/${number}`)

  return 0
}

export async function listPullRequests(options: ListOptions = {}): Promise<number> {
  const here = await standing()
  if (!here)
    return notInACheckout()

  const connection = { instance: here.instance, token: await tokenFor(here.instance) }

  const listed = await call(connection, 'GET', '/api/repos/pulls', {
    query: {
      owner: here.owner,
      repo: here.repository,
      state: options.state ?? 'open',
      author: options.author,
    },
  })

  if (!listed.ok)
    return report(listed)

  const rows: any[] = listed.data?.pull_requests ?? []
  if (rows.length === 0) {
    console.log('Nothing open.')

    return 0
  }

  for (const row of rows) {
    const marks = [row.draft ? 'draft' : '', row.state !== 'open' ? row.state : ''].filter(Boolean)
    console.log(`#${String(row.number).padEnd(5)} ${row.title}${marks.length ? `  (${marks.join(', ')})` : ''}`)
    console.log(`      ${row.author ?? 'somebody'} · ${row.head_branch} → ${row.base_branch}`)
  }

  return 0
}

export async function checkout(number: string): Promise<number> {
  const here = await standing()
  if (!here)
    return notInACheckout()

  const connection = { instance: here.instance, token: await tokenFor(here.instance) }

  const found = await call(connection, 'GET', '/api/repos/pulls/show', {
    query: { owner: here.owner, repo: here.repository, number },
  })

  if (!found.ok)
    return report(found)

  const branch = String(found.data?.head_branch ?? '')
  const local = `pr/${number}`

  /*
   * Fetched into a `pr/<n>` branch rather than checking out the head branch by
   * name. The contributor's branch may not exist locally, may exist and be
   * something else entirely, and is theirs - a reviewer who commits on it by
   * accident has written on somebody else's branch.
   */
  if (await git('fetch', 'origin', `${branch}:${local}`) === null) {
    console.error(`Could not fetch ${branch} from origin.`)
    console.error('The branch may have been deleted, or the fork may not be a remote here.')

    return 1
  }

  if (await git('checkout', local) === null) {
    console.error(`Fetched it as ${local}, but could not check it out.`)
    console.error('Commit or stash what you are working on first.')

    return 1
  }

  console.log(`On ${local}: ${found.data?.title ?? ''}`)

  return 0
}

export async function showStack(options: StackOptions = {}): Promise<number> {
  const here = await standing()
  if (!here)
    return notInACheckout()

  const connection = { instance: here.instance, token: await tokenFor(here.instance) }

  const number = options.number ?? await numberForBranch(connection, here)
  if (!number) {
    console.error('No pull request for this branch.')
    console.error('Pass --number, or check out a branch that has one.')

    return 1
  }

  const stack = await call(connection, 'GET', '/api/repos/pulls/stack', {
    query: { owner: here.owner, repo: here.repository, number },
  })

  if (!stack.ok)
    return report(stack)

  // Bottom first, which is merge order, because that is the question a stack is
  // asked: what lands next.
  for (const member of (stack.data?.stack ?? []) as any[]) {
    console.log(`${member.is_current ? '→' : ' '} #${String(member.number).padEnd(5)} ${member.title}`)

    if (member.orphaned)
      console.log(`    ${member.orphaned}`)
  }

  console.log('')
  console.log(stack.data?.summary ?? '')

  return 0
}

export async function submitReview(number: string, options: ReviewOptions = {}): Promise<number> {
  const here = await standing()
  if (!here)
    return notInACheckout()

  if (options.approve && options.requestChanges) {
    console.error('Pick one: --approve or --request-changes.')

    return 1
  }

  const connection = { instance: here.instance, token: await tokenFor(here.instance) }

  /*
   * From a file, or standard input, because a review is prose and prose belongs
   * in an editor. A `--body` flag is fine for one sentence and hostile for the
   * paragraph a real review is, which is why this command exists at all.
   */
  const body = await read(options.file ?? '-')
  if (body === null)
    return 1

  const state = options.approve ? 'approved' : options.requestChanges ? 'changes_requested' : 'commented'

  const submitted = await call(connection, 'POST', '/api/repos/pulls/reviews', {
    body: { owner: here.owner, repo: here.repository, number, state, body },
  })

  if (!submitted.ok)
    return report(submitted)

  console.log(`Submitted: ${state.replace('_', ' ')} on #${number}.`)

  return 0
}

/** The instance for this command: named, or read from the checkout. */
async function instanceFor(named?: string): Promise<string | null> {
  const explicit = String(named ?? '').trim()
  if (explicit)
    return explicit

  const here = await standing()
  if (here)
    return here.instance

  console.error('Not in a checkout of a ReviewOS repository, and no --instance given.')

  return null
}

function notInACheckout(): number {
  console.error('Not in a git checkout with a remote this recognises.')
  console.error('Run this inside a clone, or set REVIEWOS_URL.')

  return 1
}

/** The pull request whose head is the branch we are standing on. */
async function numberForBranch(
  connection: { instance: string, token: string | null },
  here: { owner: string, repository: string, branch: string | null },
): Promise<string | null> {
  if (!here.branch)
    return null

  const listed = await call(connection, 'GET', '/api/repos/pulls', {
    query: { owner: here.owner, repo: here.repository, state: 'open' },
  })

  if (!listed.ok)
    return null

  const found = (listed.data?.pull_requests ?? []).find((row: { head_branch?: unknown, number?: unknown }) => String(row.head_branch) === here.branch)

  return found ? String(found.number) : null
}

/** A file, or standard input when the path is `-`. */
async function read(path: string): Promise<string | null> {
  try {
    if (path === '-') {
      const text = await new Response(Bun.stdin.stream()).text()

      if (!text.trim()) {
        console.error('Nothing on standard input.')
        console.error('Pass --file, or pipe the review in.')

        return null
      }

      return text
    }

    return await Bun.file(path).text()
  }
  catch {
    console.error(`Could not read ${path}.`)

    return null
  }
}

/** Ask for one line. */
async function prompt(question: string): Promise<string> {
  process.stdout.write(question)

  for await (const line of console)
    return String(line).trim()

  return ''
}
