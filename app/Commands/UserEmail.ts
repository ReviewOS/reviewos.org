import type { CLI } from '@stacksjs/types'
import { db } from '@stacksjs/database'
import { associateVerifiedEmail } from '../Actions/Identity/emails'

export default function (cli: CLI) {
  cli.command('user:email:add <handle> <email>', 'Associate an operator-verified email with an existing account')
    .action(async (handle: string, email: string) => {
      const user = await db.selectFrom('users').select(['id', 'handle']).where('handle', '=', handle.toLowerCase()).executeTakeFirst()
      if (!user)
        throw new Error('No such account')
      await associateVerifiedEmail(Number(user.id), email)
      console.log(`Associated ${email.trim().toLowerCase()} with ${user.handle}`)
    })
}
