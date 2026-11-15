import process from 'node:process'
import { call, report } from './api'
import { HOSTED_INSTANCE, otherForge, standing } from './context'
import { tokenFor } from './keychain'

export async function readApiBody(path?: string): Promise<unknown> {
  if (!path) return undefined
  const stream = path === '-' ? Bun.stdin.stream() : Bun.file(path).stream()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 1_048_576) throw new Error('API input exceeds 1 MiB')
      chunks.push(value)
    }
  }
  finally { await reader.cancel(); reader.releaseLock() }
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) }
  catch { throw new Error('API input must be valid JSON') }
}

/** Machine-readable access to the same public API, using the normal CLI identity. */
export async function apiCommand(path: string, options: {
  instance?: string
  method?: string
  body?: unknown
  write?: (json: string) => void
} = {}): Promise<number> {
  const method = options.method ?? 'GET'
  const instance = options.instance || process.env.REVIEWOS_URL || (await standing())?.instance || HOSTED_INSTANCE
  let origin: URL
  try { origin = new URL(instance) }
  catch { console.error('The instance must be an HTTP or HTTPS origin.'); return 1 }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || otherForge(origin.href)) {
    console.error('Name a ReviewOS instance origin, without credentials, a path or a query.')
    return 1
  }
  // Authenticate only an API path on this instance. URL normalization must not
  // turn encoded traversal, a backslash or an absolute URL into another target.
  if (!path.startsWith('/api/') || /[\\#\r\n]/.test(path)
    || new URL(path, origin).pathname !== path.split('?')[0]
    || !['GET', 'POST', 'PUT', 'DELETE'].includes(method)
    || method === 'GET' && options.body !== undefined) {
    console.error('Use a canonical /api/ path and GET, POST, PUT or DELETE. GET has no body.')
    return 1
  }
  const answer = await call({ instance: origin.origin, token: await tokenFor(origin.origin) }, method as 'GET' | 'POST' | 'PUT' | 'DELETE', path, { body: options.body })
  if (!answer.ok) return report(answer)
  const write = options.write ?? console.log
  write(JSON.stringify(answer.data))
  return 0
}
