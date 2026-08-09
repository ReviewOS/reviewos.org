#!/usr/bin/env bun
/**
 * `reviewos` - the contributor CLI, as a standalone binary.
 *
 * Separate from `buddy` on purpose. `buddy` is this project's development CLI
 * and refuses to run outside a Stacks checkout, which is correct for it and
 * useless for the person this is written for: somebody who cloned a repository
 * hosted on a ReviewOS instance and has never seen this codebase.
 *
 * Build it with `bun build --compile cli/reviewos.ts --outfile reviewos`. The
 * result needs no runtime installed.
 *
 * Argument parsing and nothing else - every command's behaviour is in
 * `app/Cli/commands.ts`, which the `buddy` registration calls the same way. Two
 * front ends, one implementation.
 *
 * Parsed by hand rather than with an argument library, because the whole
 * surface is eight commands and four flags, and a compiled binary that pulls in
 * a parser for that is a binary that is mostly parser.
 */

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
} from '../app/Cli/commands'

const USAGE = `reviewos - the review surface, from a terminal

  reviewos login [--token <token>] [--instance <url>]
  reviewos logout [--instance <url>]
  reviewos whoami [--instance <url>]

  reviewos pr [--title <title>] [--body <body>] [--base <branch>] [--draft]
  reviewos pr list [--state open|closed|merged|all] [--author <handle>]
  reviewos pr checkout <number>

  reviewos stack [--number <number>]
  reviewos review <number> [--approve | --request-changes] [--file <path>]

The instance and the repository are read from the git remote of the checkout
you are standing in. REVIEWOS_URL overrides the instance; REVIEWOS_TOKEN
overrides the stored token, which is what CI uses.

A token is kept in the operating system's keychain, never in a dotfile.
`

/** Flags and positionals, from argv. */
function parse(argv: string[]): { positional: string[], flags: Record<string, string | boolean> } {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index])

    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }

    const name = argument.slice(2)
    const next = argv[index + 1]

    // `--flag value` and `--flag` both. A flag whose next argument is another
    // flag is a boolean, which is what makes `--draft --title x` work in either
    // order.
    if (next !== undefined && !String(next).startsWith('--')) {
      flags[name] = String(next)
      index += 1
    }
    else {
      flags[name] = true
    }
  }

  return { positional, flags }
}

const { positional, flags } = parse(process.argv.slice(2))
const [command, second, third] = positional

if (!command || flags.help || command === 'help') {
  console.log(USAGE)
  process.exit(command ? 0 : 1)
}

const instance = typeof flags.instance === 'string' ? flags.instance : undefined

async function main(): Promise<number> {
  switch (command) {
    case 'login':
      return await login({ token: typeof flags.token === 'string' ? flags.token : undefined, instance })

    case 'logout':
      return await logout({ instance })

    case 'whoami':
      return await whoami({ instance })

    case 'pr': {
      // `pr` opens one; `pr list` and `pr checkout` are the subcommands. Same
      // shape as the buddy registration's `pr:list`, spelled the way a person
      // types it in a shell.
      if (second === 'list') {
        return await listPullRequests({
          state: typeof flags.state === 'string' ? flags.state : undefined,
          author: typeof flags.author === 'string' ? flags.author : undefined,
        })
      }

      if (second === 'checkout') {
        if (!third) {
          console.error('Which pull request? `reviewos pr checkout 12`')

          return 1
        }

        return await checkout(String(third))
      }

      return await openPullRequest({
        title: typeof flags.title === 'string' ? flags.title : undefined,
        body: typeof flags.body === 'string' ? flags.body : undefined,
        base: typeof flags.base === 'string' ? flags.base : undefined,
        draft: Boolean(flags.draft),
      })
    }

    case 'stack':
      return await showStack({ number: typeof flags.number === 'string' ? flags.number : second })

    case 'review': {
      if (!second) {
        console.error('Which pull request? `reviewos review 12 --approve`')

        return 1
      }

      return await submitReview(String(second), {
        approve: Boolean(flags.approve),
        requestChanges: Boolean(flags['request-changes']),
        file: typeof flags.file === 'string' ? flags.file : undefined,
      })
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run `reviewos help` for the list.')

      return 1
  }
}

process.exit(await main())
