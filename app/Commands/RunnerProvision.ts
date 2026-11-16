import type { CLI } from '@stacksjs/types'
import type { SshTransport, SystemSshTransportDeps } from '@stacksjs/ts-cloud/drivers'
import { SystemSshTransport } from '@stacksjs/ts-cloud/drivers'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { isIP } from 'node:net'

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
    .option('--attempt-unavailable', 'Ask for the declared size even when Hetzner reports it out of stock, this once. A failed placement powers the box back on as it was.', { default: false })
    .option('--binary <path>', 'A compiled runner to install when it differs from the box\'s')
    .option('--existing-host <address>', 'Update only the runner binary on an existing declared box at this IP, without provisioning or resizing it')
    .option('--restart <how>', 'After installing a binary: signal (finish the job, then restart) or none', { default: 'signal' })
    .option('--identity <path>', 'SSH private key for root on the box', { default: resolve(homedir(), '.ssh/id_ed25519') })
    .action(async (name: string | undefined, options: any) => {
      try {
        const { tsCloud } = await import('../../config/cloud')
        const declared = (tsCloud.infrastructure?.boxes ?? {}) as Record<string, any>
        const key = name ?? (Object.keys(declared).length === 1 ? Object.keys(declared)[0] : undefined)
        const declaredBox = key ? declared[key] : undefined
        /*
         * The stock flag is best effort: a size can read out of stock in every
         * location and still place. Asking anyway is a one-off decision for
         * whoever is at the terminal, not a property of the box - written into
         * the declaration it would power the runner off on every converge.
         */
        const box = declaredBox && options.attemptUnavailable
          ? { ...declaredBox, resize: { ...(declaredBox.resize ?? {}), attemptUnavailable: true } }
          : declaredBox

        if (!box) {
          console.error(`Which box? Declared: ${Object.keys(declared).join(', ') || 'none'}`)
          process.exit(1)
        }

        const identity = String(options.identity)
        if (!existsSync(identity) || !existsSync(`${identity}.pub`)) {
          console.error(`No SSH key pair at ${identity}(.pub)`)
          process.exit(1)
        }

        const { HetznerClient, provisionBox } = await import('@stacksjs/ts-cloud/drivers')
        const ssh = runnerUpdateTransport(identity)
        if (options.existingHost) {
          const host = String(options.existingHost)
          if (!isIP(host) || !options.binary || !existsSync(String(options.binary)))
            throw new Error('--existing-host needs an IP address and an existing --binary file')
          if (options.attemptUnavailable)
            throw new Error('--existing-host cannot resize or change cloud placement')
          if (!['signal', 'none'].includes(String(options.restart)))
            throw new Error('--restart takes signal or none')
          if (options.dryRun)
            console.log(`${box.name} (${host}): update the runner binary only; no provisioning or resize`)
          else
            await installBinary(box, host, String(options.binary), String(options.restart), ssh)
          return
        }

        const token = process.env.HCLOUD_TOKEN
        if (!token)
          throw new Error('HCLOUD_TOKEN is not set: the Hetzner project the box lives in.')
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
          await installBinary(box, result.box.publicIp, String(options.binary), String(options.restart), ssh)

        process.exit(0)
      }
      catch (error) {
        console.error(`Could not provision: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

export function runnerUpdateTransport(identity: string, knownHostsFile = resolve('storage/cloud/known_hosts'), deps?: SystemSshTransportDeps): SshTransport {
  return new SystemSshTransport({ user: 'root', identityFile: identity, hostKey: { policy: 'pin', knownHostsFile } }, deps)
}

export async function installBinary(
  box: any,
  host: string,
  binary: string,
  restart: string,
  ssh: Pick<SshTransport, 'exec' | 'scp'>,
): Promise<void> {
  const user = String(box.user?.name ?? '')
  const [service, declared] = Object.entries(box.services ?? {})[0] as [string, any] ?? []
  if (!user || !service || !String(declared?.exec ?? '').startsWith('%h/')) {
    throw new Error('--binary needs a box with a user and a service whose exec is a file in its home (%h/...)')
  }
  if (!existsSync(binary)) throw new Error(`No runner binary at ${binary}`)

  const home = (await ssh.exec(host, `getent passwd ${user} | cut -d: -f6`)).trim()
  const target = `${home}/${String(declared.exec).slice(3)}`
  const local = createHash('sha256').update(readFileSync(binary)).digest('hex')
  const remote = (await ssh.exec(host, `sha256sum ${target} 2>/dev/null | cut -d' ' -f1 || true`)).trim()

  if (local === remote) {
    console.log(`  the runner binary is already ${local.slice(0, 12)}`)
    return
  }

  await ssh.scp(host, binary, `${target}.next`)
  const uploaded = (await ssh.exec(host, `sha256sum ${target}.next | cut -d' ' -f1`)).trim()
  if (uploaded !== local)
    throw new Error('The uploaded runner checksum differs; the installed binary was left in place')
  await ssh.exec(host, [
    `chown ${user}:${user} ${target}.next && chmod 755 ${target}.next`,
    `[ -f ${target} ] && cp -p ${target} ${target}.before-${remote.slice(0, 12) || 'none'} || true`,
    `mv ${target}.next ${target}`,
  ].join(' && '))
  console.log(`  installed runner ${local.slice(0, 12)} (was ${remote.slice(0, 12) || 'none'})`)

  if (restart === 'signal') {
    // Only the runner handles draining; its active job children must keep running.
    await ssh.exec(host, `sudo -u ${user} XDG_RUNTIME_DIR=/run/user/$(id -u ${user}) systemctl --user kill --kill-who=main -s SIGUSR2 ${service}.service`)
    console.log(`  asked ${service} to finish its job and restart onto it`)
  }
  else {
    console.log(`  ${service} keeps running the old binary until it next starts`)
  }
}
