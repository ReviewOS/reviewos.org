import { response } from '@stacksjs/router'
import { safeRedirect, wantsHtml } from '../Auth/session'

export class ForgeError extends Error {
  constructor(message: string, public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503 = 422) {
    super(message)
  }
}

export function positiveId(value: unknown): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1)
    throw new ForgeError('Expected a positive whole number')
  return id
}

export function pageOffset(value: unknown): number {
  const offset = Number(value ?? 0)
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
}

export function titleField(value: unknown, label = 'Title'): string {
  const title = String(value ?? '').trim()
  if (!title || title.length > 160)
    throw new ForgeError(`${label} must be between 1 and 160 characters`)
  return title
}

export function forgeResult(request: RequestInstance, data: unknown, location: string, status: 200 | 201 = 200): Response {
  return wantsHtml(request)
    ? response.redirect(safeRedirect(location), 303)
    : response.json(data, status)
}

/** Only domain refusals are translated here. Operational failures reach the router. */
export async function forgeResponse(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work()
  }
  catch (error) {
    if (error instanceof ForgeError)
      return response.json({ error: error.message }, error.status)
    throw error
  }
}
