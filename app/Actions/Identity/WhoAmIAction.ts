import { Action } from '@stacksjs/actions'
import { currentActor } from './lookup'

/**
 * Who this credential belongs to.
 *
 * The third endpoint the CLI needed and did not have, and the smallest useful
 * thing an API can offer: a caller holding a token needs one call that answers
 * "did this work, and as whom" without guessing at a repository first.
 *
 * `reviewos login` uses it to check a token *before* storing it. Storing one
 * that does not work and finding out on the next command is a worse first
 * experience than one extra round trip.
 *
 * Deliberately thin. It reports the account, not its repositories, its
 * organizations or its tokens - each of those is a list somebody would then
 * want paged and filtered, and this is the endpoint that has to stay cheap
 * enough to call on every sign-in.
 */
export default new Action({
  name: 'WhoAmI',
  description: 'The account behind the credential on this request',
  method: 'GET',

  async handle(request: RequestInstance) {
    /*
     * `currentActor`, not `currentUser`.
     *
     * `currentUser` deliberately refuses to resolve this project's own
     * fine-grained tokens - answering "who is this" for one would drop its
     * reach and its grants, which is right where those matter. Here they do
     * not: the question is only which account the credential belongs to.
     *
     * Using the wrong one made this answer 401 to exactly the credential this
     * forge issues, which is the credential `reviewos login` checks before
     * storing. A CLI that refuses every real token is a CLI nobody gets past
     * the first command with.
     */
    const { user, token } = await currentActor(request)

    if (!user) {
      /*
       * A plain 401 rather than the phase's error envelope with a `fix`. The
       * only fix is "sign in", the caller of this endpoint is asking precisely
       * whether they are, and a sentence telling them to do the thing they were
       * checking reads as a broken answer.
       */
      return response.json({ error: 'Unauthenticated' }, 401)
    }

    return response.json({
      handle: user.handle,
      is_admin: user.is_admin,
      /*
       * Which credential answered, when it was a token.
       *
       * A person holding three tokens and debugging why one of them cannot do
       * something needs to know *which* one the server saw, and comparing a
       * prefix by eye is how the wrong one gets revoked.
       */
      token_id: token?.tokenId ?? null,
    })
  },
})
