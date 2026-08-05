import { route } from '@stacksjs/router'
import { diskPathFor, findRepositoryByPath, mayUseService, tokenFromBasicAuth } from '../app/Actions/Git/access'
import { recordTokenUse } from '../app/Actions/Tokens/authenticate'
import { spawnGit } from '../app/Actions/Git/git'
import { GATE_ENDPOINT, HOOK_ENDPOINT, hookSecret, repositoryByGitDir } from '../app/Actions/Git/hooks'
import { decidePush, rulesFor } from '../app/Actions/Git/protection'
import { parseRefUpdates } from '../app/Actions/Git/push'
import { isAncestor } from '../app/Actions/Mirror/fetch'
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

/**
 * Compare two secrets without leaking how far they matched.
 *
 * The window is small here - this is loopback, and the secret is long - but a
 * comparison that returns early is a comparison that can be measured, and
 * doing it right costs one loop.
 */
function sameSecret(offered: string, expected: string): boolean {
  const a = new TextEncoder().encode(offered)
  const b = new TextEncoder().encode(expected)

  let difference = a.length ^ b.length
  for (let i = 0; i < b.length; i += 1)
    difference |= (a[i] ?? 0) ^ b[i]!

  return difference === 0
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
 * Where the pre-receive hook asks whether a push may land.
 *
 * The only endpoint in the product that can refuse work that has not happened
 * yet, which is the whole point: once `receive-pack` has written the ref, the
 * dropped commits are unreachable and everybody who fetches has the rewritten
 * history. Refusing afterwards is a notification.
 *
 * Whether a push is a *force* push is asked of git rather than of the client.
 * `--force` is a flag the client chooses to send; dropping history is what
 * actually happened, and the honest test is whether the commit the branch used
 * to point at is still reachable from the one it now points at.
 */
route.post(GATE_ENDPOINT, async (request: any) => {
  const secret = hookSecret()
  if (!secret)
    return new Response('Not found', { status: 404 })

  const offered = String(request.headers?.get?.('x-git-hook-secret') ?? '')
  if (!sameSecret(offered, secret))
    return new Response('Not found', { status: 404 })

  const allow = (extra: Record<string, unknown> = {}) => new Response(
    JSON.stringify({ ok: true, ...extra }),
    { headers: { 'Content-Type': 'application/json' } },
  )

  const payload = await request.json().catch(() => null)
  const gitDir = String(payload?.gitDir ?? '')
  const updates = parseRefUpdates(String(payload?.updates ?? ''))

  if (!gitDir || updates.length === 0)
    return allow()

  const repository: any = await repositoryByGitDir(gitDir)
  if (!repository)
    return allow()

  const rules: any[] = await db
    .selectFrom('protected_branches')
    .select(['pattern', 'allow_force_push', 'allow_deletion'])
    .where('repository_id', '=', Number(repository.id))
    .execute()

  if (rules.length === 0)
    return allow()

  const judged = []
  for (const update of updates) {
    // Only asked when a rule could refuse it, because it costs a git process
    // per ref and most pushes are covered by no rule at all.
    const forced = update.change === 'updated' && rulesFor(rules, update.name).length > 0
      ? !(await isAncestor(gitDir, update.before, update.after))
      : false

    judged.push({ update, isForced: forced })
  }

  const decision = decidePush(rules, judged)

  return new Response(JSON.stringify(decision), {
    headers: { 'Content-Type': 'application/json' },
  })
}).skipCsrf()

/**
 * Where the post-receive hook reports a push.
 *
 * Local to the instance: the hook runs on the same machine as the application
 * and posts to loopback, so this is not an endpoint anybody outside is meant
 * to reach. The shared secret is what makes it answerable at all, and with no
 * secret configured the endpoint does not exist rather than accepting
 * everything - a default secret is a published secret.
 *
 * The secret gets a request *heard*, and nothing further is taken on trust.
 * Every ref line is re-parsed and shape-checked, the repository is resolved
 * from its path on disk rather than from a name in the body, and all the actual
 * work happens in a job that reads what the repository now contains. A caller
 * who guesses the secret can ask the application to look at a repository; they
 * cannot tell it what it will find.
 *
 * It answers immediately. A hook that waits is a `git push` that waits, and
 * walking the commits of a large push takes longer than anybody should stand at
 * a prompt for.
 */
route.post(HOOK_ENDPOINT, async (request: any) => {
  const secret = hookSecret()
  if (!secret)
    return new Response('Not found', { status: 404 })

  const offered = String(request.headers?.get?.('x-git-hook-secret') ?? '')

  // 404 rather than 401, the same answer a private repository gives: a 401
  // confirms the endpoint is here and worth guessing at.
  if (!sameSecret(offered, secret))
    return new Response('Not found', { status: 404 })

  const payload = await request.json().catch(() => null)
  const gitDir = String(payload?.gitDir ?? '')
  const updates = parseRefUpdates(String(payload?.updates ?? ''))

  if (!gitDir || updates.length === 0)
    return new Response(JSON.stringify({ ok: true, updates: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    })

  const { default: ProcessPushJob } = await import('../app/Jobs/ProcessPushJob')
  await ProcessPushJob.dispatch({ gitDir, updates })

  return new Response(JSON.stringify({ ok: true, updates: updates.length }), {
    headers: { 'Content-Type': 'application/json' },
  })
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
