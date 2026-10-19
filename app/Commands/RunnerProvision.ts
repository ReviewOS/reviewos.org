import type { CLI } from '@stacksjs/types'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'

/**
 * Converge a runner's machine to its declaration in `cloud/boxes.ts`.
 *
 * ts-cloud does the machine: it finds the server by name (adopting it if it
 * already exists), applies its firewall, installs the declared pantry packages
 * and writes the runner's systemd user unit, all idempotently. A converge
 * never restarts a running runner, because the job it is in the middle of is
 * somebody's build.
 *
 * `--binary` does the runner itself: the compiled program (`buddy
 * build:runner --target linux-x64`) replaces the one on the box when it
 * differs, and the old one stays beside it. The new one takes over when the
 * runner next starts; `--restart signal` asks the running one to finish its
 * job and leave (SIGUSR2), and the service manager starts the new binary.
 * Only a runner built with that handler (83b4f4c3 and later) understands the
 * signal - to anything older SIGUSR2 is a kill - so a box still on an older
 * build takes `--restart none` and a graceful `stop-runner` from the instance.
 */
export default function (cli: CLI) {
  cli
    .command('runner:provision [box]', 'Converge a runner box declared in cloud/boxes.ts')
    .option('--dry-run', 'Show what would change without touching the box', { default: false })
    .option('--binary <path>', 'A compiled runner to install when it differs from the box\'s')
    .option('--restart <how>', 'After installing a binary: signal (finish the job, then restart) or none', { default: 'signal' })
    .option('--identity <path>', 'SSH private key for root on the box', { default: resolve(homedir(), '.ssh/id_ed25519') })
    .action(async (name: string | undefined, options: any) => {
      try {
        const { tsCloud } = await import('../../config/cloud')
        const declared = (tsCloud.infrastructure?.boxes ?? {}) as Record<string, any>
        const key = name ?? (Object.keys(declared).length === 1 ? Object.keys(declared)[0] : undefined)
        const box = key ? declared[key] : undefined

        if (!box) {
          console.error(`Which box? Declared: ${Object.keys(declared).join(', ') || 'none'}`)
          process.exit(1)
        }

        const token = process.env.HCLOUD_TOKEN
        if (!token) {
          console.error('HCLOUD_TOKEN is not set: the Hetzner project the box lives in.')
          process.exit(1)
        }

        const identity = String(options.identity)
        if (!existsSync(identity) || !existsSync(`${identity}.pub`)) {
          console.error(`No SSH key pair at ${identity}(.pub)`)
          process.exit(1)
        }

        const { HetznerClient, provisionBox, sshExecOrThrow, scpUpload } = await import('@stacksjs/ts-cloud/drivers')
        const result = await provisionBox({
          box,
          client: new HetznerClient({ apiToken: token }),
          sshPublicKey: readFileSync(`${identity}.pub`, 'utf8'),
          identityFile: identity,
          knownHostsFile: resolve('storage/cloud/known_hosts'),
          dryRun: Boolean(options.dryRun),
          onPhase: phase => console.log(`  ${phase}`),
        })

        console.log(`${box.name} (${result.box.publicIp})${result.box.created ? ', created' : ''}${options.dryRun ? ', dry run' : ''}`)
        for (const line of result.report) console.log(`  ${line}`)

        if (options.binary && !options.dryRun)
          await installBinary(box, result.box.publicIp, String(options.binary), String(options.restart), identity, { sshExecOrThrow, scpUpload })

        process.exit(0)
      }
      catch (error) {
        console.error(`Could not provision: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

export async function installBinary(
  box: any,
  host: string,
  binary: string,
  restart: string,
  identity: string,
  ssh: { sshExecOrThrow: (host: string, command: string, options?: any) => Promise<string>, scpUpload: (host: string, paths: string[], dir: string, options?: any) => Promise<void> },
): Promise<void> {
  const user = String(box.user?.name ?? '')
  const [service, declared] = Object.entries(box.services ?? {})[0] as [string, any] ?? []
  if (!user || !service || !String(declared?.exec ?? '').startsWith('%h/')) {
    throw new Error('--binary needs a box with a user and a service whose exec is a file in its home (%h/...)')
  }
  if (!existsSync(binary)) throw new Error(`No runner binary at ${binary}`)

  const options = { identityFile: identity }
  const home = (await ssh.sshExecOrThrow(host, `getent passwd ${user} | cut -d: -f6`, options)).trim()
  const target = `${home}/${String(declared.exec).slice(3)}`
  const local = createHash('sha256').update(readFileSync(binary)).digest('hex')
  const remote = (await ssh.sshExecOrThrow(host, `sha256sum ${target} 2>/dev/null | cut -d' ' -f1 || true`, options)).trim()

  if (local === remote) {
    console.log(`  the runner binary is already ${local.slice(0, 12)}`)
    return
  }

  await ssh.scpUpload(host, [binary], `${target}.next`, options)
  await ssh.sshExecOrThrow(host, [
    `chown ${user}:${user} ${target}.next && chmod 755 ${target}.next`,
    `[ -f ${target} ] && cp -p ${target} ${target}.before-${remote.slice(0, 12) || 'none'} || true`,
    `mv ${target}.next ${target}`,
  ].join(' && '), options)
  console.log(`  installed runner ${local.slice(0, 12)} (was ${remote.slice(0, 12) || 'none'})`)

  if (restart === 'signal') {
    // Only the runner handles draining; its active job children must keep running.
    await ssh.sshExecOrThrow(host, `sudo -u ${user} XDG_RUNTIME_DIR=/run/user/$(id -u ${user}) systemctl --user kill --kill-who=main -s SIGUSR2 ${service}.service`, options)
    console.log(`  asked ${service} to finish its job and restart onto it`)
  }
  else {
    console.log(`  ${service} keeps running the old binary until it next starts`)
  }
}
