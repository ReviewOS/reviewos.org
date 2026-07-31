import { route } from '@stacksjs/router'
import { diskPathFor, findRepositoryByPath, mayUseService, tokenFromBasicAuth } from '../app/Actions/Git/access'
import { recordTokenUse } from '../app/Actions/Tokens/authenticate'
import { spawnGit } from '../app/Actions/Git/git'
import { gitService, parseGitUrl } from '../app/Actions/Git/storage'

/**
 * The git wire protocol, at the root.
 *
 * `git clone https://host/owner/repo.git` asks for
 * `/owner/repo.git/info/refs`, so these cannot sit under `/api`. They are
 * registered here and mounted with an empty prefix by `app/Routes.ts`.
 *
 * Everything streams. A packfile for a real repository is far larger than
 * anything worth holding in memory, and buffering it would pass every test
 * written against a small repository and fall over on the first big one.
 */

/** The `# service=...` banner that opens a smart-HTTP advertisement. */
function packetLine(payload: string): string {
  const length = (payload.length + 4).toString(16).padStart(4, '0')
  return `${length}${payload}`
}

async function authorize(request: any, service: 'upload-pack' | 'receive-pack') {
  const parsed = parseGitUrl(new URL(request.url).pathname)
  if (!parsed)
    return { ok: false as const, status: 404 }

  const repository = await findRepositoryByPath(parsed.owner, parsed.name)
  if (!repository)
    return { ok: false as const, status: 404 }

  const token = await tokenFromBasicAuth(request.headers?.get?.('authorization') ?? null)
  const userId = token?.userId ?? null
  const allowed = await mayUseService(repository, userId, service, token)

  if (allowed && token) {
    // Not awaited: an unused token being visible as unused is worth a write,
    // but not worth delaying a clone for, and never worth failing one over.
    void recordTokenUse(token.tokenId, request.headers?.get?.('x-forwarded-for') ?? null)
  }

  if (!allowed) {
    // A private repository answers 404 to somebody who cannot read it, rather
    // than 401: a 401 confirms the repository exists, which is the one thing
    // the visitor is not allowed to know.
    if (userId === null && repository.visibility === 'public')
      return { ok: false as const, status: 401 }
    return { ok: false as const, status: repository.visibility === 'public' ? 403 : 404 }
  }

  const path = diskPathFor(parsed.owner, parsed.name)
  if (!path)
    return { ok: false as const, status: 404 }

  return { ok: true as const, path }
}

function unauthorized(status: number): Response {
  const headers: Record<string, string> = {}
  if (status === 401)
    headers['WWW-Authenticate'] = 'Basic realm="ReviewOS"'

  return new Response(status === 401 ? 'Authentication required' : 'Not found', { status, headers })
}

/**
 * Ref advertisement: the first thing a clone or push asks for.
 */
route.get('/{owner}/{repository}/info/refs', async (request: any) => {
  const url = new URL(request.url)
  const service = gitService(url.pathname, url.searchParams)

  // Without a service parameter this is a request for the dumb protocol, which
  // is not served: it needs the repository to keep an `info/refs` file up to
  // date, and every git since 1.6.6 speaks the smart one.
  if (!service)
    return new Response('Smart HTTP protocol required', { status: 400 })

  const auth = await authorize(request, service)
  if (!auth.ok)
    return unauthorized(auth.status)

  const child = spawnGit(auth.path, [`${service}`, '--stateless-rpc', '--advertise-refs', '.'])

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(packetLine(`# service=git-${service}\n`)))
      controller.enqueue(new TextEncoder().encode('0000'))
      child.stdout.on('data', chunk => controller.enqueue(new Uint8Array(chunk)))
      child.stdout.on('end', () => controller.close())
      child.on('error', () => controller.close())
    },
    cancel() {
      child.kill('SIGKILL')
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': `application/x-git-${service}-advertisement`,
      // git caches aggressively otherwise, and a stale ref advertisement makes
      // a fetch quietly miss commits.
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
    },
  })
}).skipCsrf()

/** Fetch and clone. */
route.post('/{owner}/{repository}/git-upload-pack', async (request: any) => {
  const auth = await authorize(request, 'upload-pack')
  if (!auth.ok)
    return unauthorized(auth.status)

  return streamService(request, auth.path, 'upload-pack')
}).skipCsrf()

/** Push. */
route.post('/{owner}/{repository}/git-receive-pack', async (request: any) => {
  const auth = await authorize(request, 'receive-pack')
  if (!auth.ok)
    return unauthorized(auth.status)

  return streamService(request, auth.path, 'receive-pack')
}).skipCsrf()

/**
 * Pipe the request body into git and its output back out, without either side
 * being held in memory.
 */
function streamService(request: any, path: string, service: 'upload-pack' | 'receive-pack'): Response {
  const child = spawnGit(path, [service, '--stateless-rpc', '.'])

  const body: ReadableStream | null = request.body ?? null
  if (body) {
    const reader = body.getReader()
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done)
          break
        child.stdin.write(value)
      }
      child.stdin.end()
    }
    pump().catch(() => child.kill('SIGKILL'))
  }
  else {
    child.stdin.end()
  }

  const stream = new ReadableStream({
    start(controller) {
      child.stdout.on('data', chunk => controller.enqueue(new Uint8Array(chunk)))
      child.stdout.on('end', () => controller.close())
      child.on('error', () => controller.close())
    },
    cancel() {
      child.kill('SIGKILL')
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': `application/x-git-${service}-result`,
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    },
  })
}
