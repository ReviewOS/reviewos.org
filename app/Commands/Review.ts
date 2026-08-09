import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import {
  checkout,
  listPullRequests,
  login,
  logout,
  openPullRequest,
  showStack,
  submitReview,
  whoami,
} from '../Cli/commands'

/**
 * The contributor CLI, registered on `buddy` for working inside this repository.
 *
 * Argument parsing and nothing else. Every command's behaviour lives in
 * `app/Cli/commands.ts`, which the standalone `reviewos` binary calls the same
 * way - two front ends, one implementation, so a fix to either reaches both.
 *
 * The commands are the four where a terminal genuinely wins, because the answer
 * is already in the working copy or the input is already in a file: open a pull
 * request from the branch you are on, check out somebody else's, see the stack,
 * submit a review written in an editor. A CLI that mirrors the whole product is
 * a second product to maintain, and the browser is better at most of it.
 */
export default function (cli: CLI) {
  const run = (work: Promise<number>) => work.then(code => process.exit(code))

  cli
    .command('login', 'Store an access token for this instance in the OS keychain')
    .option('--token <token>', 'The token, if you would rather not be prompted')
    .option('--instance <url>', 'Override the instance, normally read from the git remote')
    .action((options: { token?: string, instance?: string }) => run(login(options)))

  cli
    .command('logout', 'Forget the token for this instance')
    .option('--instance <url>', 'Override the instance')
    .action((options: { instance?: string }) => run(logout(options)))

  cli
    .command('whoami', 'Who the stored token belongs to')
    .option('--instance <url>', 'Override the instance')
    .action((options: { instance?: string }) => run(whoami(options)))

  cli
    .command('pr', 'Open a pull request from the branch you are on')
    .option('--title <title>', 'The title. Defaults to the last commit subject.')
    .option('--body <body>', 'The description')
    .option('--base <branch>', 'What to merge into. Defaults to the repository default.')
    .option('--draft', 'Open it as a draft', { default: false })
    .action((options: { title?: string, body?: string, base?: string, draft?: boolean }) => run(openPullRequest(options)))

  cli
    .command('pr:list', 'The pull requests in this repository')
    .option('--state <state>', 'open, closed, merged, or all', { default: 'open' })
    .option('--author <handle>', 'Only this person\'s')
    .action((options: { state?: string, author?: string }) => run(listPullRequests(options)))

  cli
    .command('pr:checkout <number>', 'Check out somebody else\'s pull request')
    .action((number: string) => run(checkout(number)))

  cli
    .command('stack', 'The stack this pull request belongs to, in merge order')
    .option('--number <number>', 'Which pull request. Defaults to the one for this branch.')
    .action((options: { number?: string }) => run(showStack(options)))

  cli
    .command('review <number>', 'Submit a review, with the body read from a file')
    .option('--approve', 'Approve it', { default: false })
    .option('--request-changes', 'Request changes', { default: false })
    .option('--file <path>', 'Read the body from this file. `-` reads standard input.')
    .action((number: string, options: { approve?: boolean, requestChanges?: boolean, file?: string }) =>
      run(submitReview(number, options)))
}
