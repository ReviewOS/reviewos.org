import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { ExitCode } from '@stacksjs/types'

/**
 * Mint this instance's VAPID keypair.
 *
 * **Every installation generates its own, and that is the point.** A key shipped
 * in the source would be shared by every self-hosted ReviewOS, which means any
 * one of them could send push notifications claiming to be any other, and one
 * compromise would need a coordinated rotation across all of them. Per-instance
 * keys are the reason the Push API has an application server key at all.
 *
 * It prints rather than writes. A command that edits its own `.env` fails on a
 * read-only deployment, succeeds confusingly on a shared one, and on a machine
 * where the file is somebody else's silently writes a key nothing will read.
 * Printing puts the operator in the loop for a decision that is theirs.
 *
 * **Running it twice is not idempotent, and it says so.** A browser subscribes
 * *to* a public key, so replacing the pair invalidates every subscription on
 * the instance and everybody has to opt in again - which is a real cost and one
 * nobody expects from a command that only prints.
 */
export default function (cli: CLI) {
  cli
    .command('push:keys', 'Generate the VAPID keypair this instance signs push notifications with')
    .action(async () => {
      try {
        const { mintVapidKeys } = await import('../Actions/Notification/vapid')
        const { publicKey, env } = await mintVapidKeys()

        const configured = Boolean(String(Bun.env.VAPID_PRIVATE_KEY ?? '').trim())

        console.log('')

        if (configured) {
          // Said before the keys, not after. Somebody who scrolls back to copy
          // them has already stopped reading by the time a warning underneath
          // would appear.
          console.log('  This instance already has VAPID keys.')
          console.log('  Replacing them invalidates every existing subscription:')
          console.log('  a browser subscribes to a public key, so everybody would')
          console.log('  have to turn notifications on again.')
          console.log('')
        }

        console.log('  Put these in your environment:')
        console.log('')
        console.log(env.split('\n').map(line => `    ${line}`).join('\n'))
        console.log('')
        console.log('  The public key is safe to expose - the browser needs it to subscribe.')
        console.log('  The private key is not, and never leaves the server.')
        console.log('')
        console.log(`  Public key: ${publicKey.slice(0, 12)}…${publicKey.slice(-6)}`)
        console.log('')
      }
      catch (error) {
        console.error('Could not generate VAPID keys:', error)
        process.exit(ExitCode.FatalError)
      }

      process.exit(ExitCode.Success)
    })
}
