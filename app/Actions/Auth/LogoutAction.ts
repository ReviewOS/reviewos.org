import { Action } from '@stacksjs/actions'
import FrameworkLogout from '@stacksjs/defaults/app/Actions/Auth/LogoutAction.ts'
import { wantsHtml } from './session'

/** Preserve ReviewOS responses while the framework revokes the active credential. */
export default new Action({
  name: 'LogoutAction',
  description: 'End the session and revoke its credential',
  method: 'POST',

  async handle(request: RequestInstance) {
    const result = await FrameworkLogout.handle(request) as Response
    const headers = new Headers(result.headers)
    headers.delete('Content-Length')
    headers.set('Cache-Control', 'no-store')
    if (wantsHtml(request)) {
      headers.set('Location', '/')
      headers.delete('Content-Type')
      return new Response(null, { status: 303, headers })
    }
    headers.delete('Location')
    headers.set('Content-Type', 'application/json')
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
  },
})
