import { Action } from '@stacksjs/actions'
import { clientMetadata } from './client'

/**
 * The client metadata document, which is also this client's identity.
 *
 * Public and unauthenticated on purpose: an authorization server fetches it
 * before anybody has signed in, and it contains nothing secret - a name, a
 * redirect, and the scope this instance asks for.
 */
export default new Action({
  name: 'AtprotoClientMetadata',
  description: 'The AT Protocol OAuth client metadata for this instance',

  method: 'GET',

  async handle() {
    const { response } = await import('@stacksjs/router')

    return response.json(clientMetadata())
  },
})
