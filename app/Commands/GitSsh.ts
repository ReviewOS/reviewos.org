import type { CLI } from '@stacksjs/types'
import process from 'node:process'

// Imported rather than relied on as a global: the actions reach `db`, which is
// a server auto-import, and a buddy command does not run through the preloader
// that injects those.
import { DEFAULT_SSH_PORT, HOST_KEY_PATH, loadHostKey, startSshServer } from '../Actions/Git/ssh'

/**
 * Serve git over SSH.
 *
 * A separate process from the web application, and deliberately: it listens on
 * a different port, it holds a private key the web process has no reason to
 * read, and a restart of one should not interrupt a clone running through the
 * other. They share the database and the repositories on disk, which is all
 * they need to agree about.
 *
 * The host key is created on first start if there is none. That is a
 * convenience with one sharp edge worth stating: it is written once and never
 * again, because a host key that changes between restarts makes every client
 * that has ever connected print the warning about a changed fingerprint - the
 * warning that is supposed to mean somebody is in the middle.
 *
 * Port 2222 by default rather than 22. Binding 22 needs root, and a forge that
 * asks to be run as root to serve git is one that gets run as root.
 */
export default function (buddy: CLI): void {
  buddy
    .command('git:ssh', 'Serve git over SSH')
    .option('--port <port>', `Port to listen on (default ${DEFAULT_SSH_PORT})`)
    .option('--host <host>', 'Address to bind (default 127.0.0.1)')
    .option('--host-key <path>', `Host key file (default ${HOST_KEY_PATH})`)
    .option('--fingerprint', 'Print the host key fingerprint and exit')
    .action(async (options: { port?: string, host?: string, hostKey?: string, fingerprint?: boolean }) => {
      const path = options?.hostKey ?? HOST_KEY_PATH

      if (options?.fingerprint) {
        const key = loadHostKey(path)
        console.error(key.fingerprint)

        return
      }

      const port = Number(options?.port ?? process.env.SSH_PORT ?? DEFAULT_SSH_PORT)

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`${options?.port} is not a port.`)
        process.exit(1)
      }

      let server
      try {
        server = startSshServer({ port, hostname: options?.host, hostKeyPath: path })
      }
      catch (error) {
        // A host key that cannot be read is a misconfiguration somebody has to
        // fix, and the error from `parsePrivateKey` names the fix.
        console.error(String(error instanceof Error ? error.message : error))
        process.exit(1)
      }

      const key = loadHostKey(path)

      console.error(`Serving git over SSH on ${options?.host ?? '127.0.0.1'}:${server.port}`)
      console.error(`Host key: ${key.fingerprint}`)
      console.error('')
      console.error('  git clone ssh://git@localhost:%d/owner/name.git', server.port)
      console.error('')

      const stop = () => {
        console.error('')
        console.error('Stopping.')
        server.stop()
        process.exit(0)
      }

      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })
}
