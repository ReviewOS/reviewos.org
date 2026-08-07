/**
 * Git over SSH.
 *
 * The other half of the wire protocol. HTTPS is what a browser and a CI job
 * use; SSH is what people use, because it authenticates with a key they already
 * have rather than with a token they have to store somewhere.
 *
 * The protocol is `ts-ssh`'s job - the handshake, the ciphers, the channels,
 * the signature check that proves somebody holds a key. What is here is the
 * three decisions a protocol library must not make for a forge:
 *
 * - **Which key is whose.** A signature says "whoever sent this holds that
 *   private key" and nothing about who that is. The answer is a row in
 *   `ssh_keys`, matched by fingerprint.
 * - **What a command means.** A client sends `git-upload-pack '/owner/name.git'`
 *   as a string. Turning that into a repository on disk is where a path
 *   traversal would live, so it goes through the same `repositoryPath` every
 *   other entry point uses.
 * - **Whether it is allowed.** `mayUseService`, the same function the HTTP
 *   routes ask. A second opinion about permissions is two answers waiting to
 *   disagree, and the one that disagrees quietly is the one that leaks.
 *
 * **The user name is ignored, deliberately.** Everybody connects as `git@`, and
 * the identity comes from the key. That is how every forge does it and it is
 * not laziness: a name is something the client chooses, and a key is something
 * it has to prove.
 */

import type { Command, PrivateKey, Server } from '@stacksjs/ts-ssh'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { db } from '@stacksjs/database'
import { fingerprintOf, generateHostKey, parsePrivateKey, parsePublicKey, serve } from '@stacksjs/ts-ssh'
import { diskPathFor, findRepositoryByPath, mayUseService } from './access'
import { gitEnvironment, serviceArgs } from './git'
import { repositoryPath } from './storage'

/** Where the host key lives, unless configured otherwise. */
export const HOST_KEY_PATH = 'storage/ssh/host_ed25519'

/** The port the daemon listens on, unless configured otherwise. */
export const DEFAULT_SSH_PORT = 2222

/** The two services a git client asks for over SSH. */
export type GitService = 'upload-pack' | 'receive-pack'

export type ParsedCommand
  = | { ok: true, service: GitService, owner: string, name: string }
    | { ok: false, message: string }

/**
 * Read the command line a git client sent.
 *
 * It arrives as one string, shell-quoted, in one of a few shapes that have
 * accumulated over the years:
 *
 *     git-upload-pack '/owner/name.git'
 *     git-upload-pack "/owner/name.git"
 *     git upload-pack /owner/name
 *     git-receive-pack '~owner/name.git'
 *
 * All of them are accepted, and nothing else is. In particular this is not a
 * shell: there is no globbing, no substitution, and no command that is not one
 * of the two. Somebody with a valid key sends this string, so treating it as
 * anything executable would turn "may push to one repository" into "may run
 * anything on the server".
 */
export function parseGitCommand(raw: string): ParsedCommand {
  const command = raw.trim()

  if (command.length === 0)
    return { ok: false, message: 'This server does not provide shell access.' }

  const [head, ...rest] = splitArguments(command)
  if (!head)
    return { ok: false, message: 'This server does not provide shell access.' }

  // `git upload-pack path` and `git-upload-pack path` are the same request.
  const verb = head === 'git' ? rest.shift() ?? '' : head.replace(/^git-/, '')
  const service = verb === 'upload-pack' || verb === 'receive-pack' ? verb : null

  if (!service)
    return { ok: false, message: `This server runs git, and ${head} is not it.` }

  const target = rest.at(-1)
  if (!target)
    return { ok: false, message: 'Name a repository: git@host:owner/name.git' }

  const parsed = splitRepositoryPath(target)
  if (!parsed)
    return { ok: false, message: `Not a repository path: ${target}` }

  // Through the same resolver every other entry point uses. A path that would
  // escape the repository root is refused here rather than being handed to git.
  const resolved = repositoryPath(parsed.owner, parsed.name)
  if (!resolved.ok)
    return { ok: false, message: `Not a repository path: ${target}` }

  return { ok: true, service, owner: parsed.owner, name: parsed.name }
}

/**
 * Split a command line the way a shell would, minus everything dangerous.
 *
 * Single and double quotes group, a backslash escapes the next character, and
 * nothing else is special. No expansion of any kind: `$HOME` is six characters
 * and `*` is one.
 */
function splitArguments(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  let started = false

  for (let index = 0; index < line.length; index++) {
    const character = line[index]!

    if (character === '\\' && index + 1 < line.length && quote !== '\'') {
      current += line[++index]
      started = true
      continue
    }

    if (quote) {
      if (character === quote)
        quote = null
      else
        current += character

      continue
    }

    if (character === '"' || character === '\'') {
      quote = character
      started = true
      continue
    }

    if (character === ' ' || character === '\t') {
      if (started) {
        parts.push(current)
        current = ''
        started = false
      }

      continue
    }

    current += character
    started = true
  }

  if (started)
    parts.push(current)

  return parts
}

/** `owner` and `name` out of `/owner/name.git`, `~owner/name`, `owner/name.git`. */
function splitRepositoryPath(target: string): { owner: string, name: string } | null {
  const trimmed = target.replace(/^[/~]+/, '').replace(/\.git$/, '')
  const segments = trimmed.split('/').filter(segment => segment.length > 0)

  if (segments.length !== 2)
    return null

  return { owner: segments[0]!, name: segments[1]! }
}

/**
 * Which account holds this key.
 *
 * By fingerprint, which is a digest of the whole blob, and the column is unique
 * across every account - so a key registered twice is refused at the point it
 * is added rather than becoming an ambiguity here.
 *
 * Returns null for a key nobody registered, and the caller answers the same
 * failure it would for a bad signature. Telling a client that a key is known
 * but unauthorised is a way to enumerate which keys a forge has seen.
 */
export async function userForKey(blob: Uint8Array): Promise<number | null> {
  const key = parsePublicKey(blob)
  if (!key)
    return null

  const row = await db
    .selectFrom('ssh_keys')
    .select(['user_id'])
    .where('fingerprint', '=', fingerprintOf(blob))
    .executeTakeFirst()

  return row ? Number(row.user_id) : null
}

/**
 * The host key, read from disk or created on first start.
 *
 * Created rather than demanded, because an instance that will not start until
 * somebody runs `ssh-keygen` is an instance nobody finishes setting up. Written
 * with 0600 and never regenerated: a host key that changes between restarts
 * makes every client that ever connected print the warning about a changed
 * fingerprint, which is the warning that is supposed to mean something.
 */
export function loadHostKey(path = HOST_KEY_PATH): PrivateKey {
  const absolute = resolve(path)

  if (existsSync(absolute))
    return parsePrivateKey(readFileSync(absolute, 'utf8'))

  const generated = generateHostKey('reviewos')

  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, generated.openssh)
  chmodSync(absolute, 0o600)
  writeFileSync(`${absolute}.pub`, generated.publicLine)

  return generated.key
}

export interface SshServerOptions {
  port?: number
  hostname?: string
  hostKeyPath?: string
  /** Reported per connection. Defaults to writing to stderr. */
  onError?: (error: unknown) => void
}

/**
 * Serve git over SSH.
 *
 * One process, one port, and every connection is a key check followed by a
 * `git-upload-pack` or `git-receive-pack` piped through a channel. The hooks
 * are the repository's own, so a push over SSH runs the same protection and
 * lands the same rows as a push over HTTPS - which is the point of not having
 * a second code path for it.
 */
export function startSshServer(options: SshServerOptions = {}): Server {
  const hostKey = loadHostKey(options.hostKeyPath)
  const report = options.onError ?? ((error: unknown) => console.error('ssh:', error))

  return serve({
    port: options.port ?? DEFAULT_SSH_PORT,
    hostname: options.hostname,
    hostKey,
    software: 'reviewos',
    onError: report,

    // The key is checked here only for *existence*: what it may do is a
    // question about a repository, and no repository has been named yet. A
    // client that authenticates and then asks for something it may not have
    // gets refused at the command, with a message it can act on.
    authenticate: async ({ blob }) => (await userForKey(blob)) !== null,

    onCommand: command => runGitCommand(command, report),
  })
}

/**
 * One `exec` request: resolve it, check it, and pipe git through the channel.
 *
 * Refusals go to stderr and exit non-zero, which is what git shows the person
 * who ran the command. A refusal that reaches them as a closed connection is
 * one they will read as "the server is broken".
 */
async function runGitCommand(command: Command, report: (error: unknown) => void): Promise<void> {
  const refuse = (message: string, status = 128) => {
    command.writeStderr(`${message}\n`)
    command.exit(status)
  }

  const parsed = parseGitCommand(command.command)
  if (!parsed.ok)
    return refuse(parsed.message)

  // From the key that authenticated, not from the name the client connected as.
  // Everybody connects as `git@`; the key is the only thing they had to prove.
  const userId = await userForKey(command.keyBlob)
  const repository = await findRepositoryByPath(parsed.owner, parsed.name)

  // The same answer for a repository that does not exist and one this account
  // may not see. Anything else turns a 'not found' into a directory of private
  // repository names.
  if (!repository || !(await mayUseService(repository, userId, parsed.service))) {
    return refuse(
      `Repository not found: ${parsed.owner}/${parsed.name}\n`
      + 'It may not exist, or your key may not have access to it.',
    )
  }

  // Resolved from the owner and name, not from `disk_path` on the row. That
  // column holds a path relative to the repository root, so resolving it
  // against the process's working directory names a repository that is not
  // there - and git's refusal quotes a path nobody will recognise.
  const path = diskPathFor(parsed.owner, parsed.name)
  if (!path)
    return refuse(`Repository not found: ${parsed.owner}/${parsed.name}`)

  // Not `--stateless-rpc`: that is the HTTP framing, where each request is one
  // round of the protocol. Over SSH the process talks for the life of the
  // channel, which is the mode git was written for.
  const child = spawn('git', serviceArgs(path, parsed.service, { stateless: false }), {
    // The same environment every other git child gets, so a push over SSH runs
    // the same declared binaries as one over HTTPS, plus the one thing only
    // this transport knows.
    env: gitEnvironment({
      // Read by the pre-receive hook, so a push over SSH is attributed to the
      // person who made it. Over HTTPS that comes from the Authorization
      // header; here there is no header and the key is the identity.
      REVIEWOS_ACTOR_ID: userId === null ? '' : String(userId),
    }),
  })

  command.onData(data => child.stdin.write(data))
  command.onEnd(() => child.stdin.end())

  child.stdout.on('data', chunk => command.write(new Uint8Array(chunk)))
  child.stderr.on('data', chunk => command.writeStderr(new Uint8Array(chunk)))

  child.on('error', (error) => {
    report(error)
    refuse('git could not be started on the server.')
  })

  child.on('close', code => command.exit(code ?? 0))
}
