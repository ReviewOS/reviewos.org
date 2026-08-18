import { route } from '@stacksjs/router'
import { diskPathFor, findRepositoryByPath, mayUseService, tokenFromBasicAuth } from '../app/Actions/Git/access'
import { recordTokenUse } from '../app/Actions/Tokens/authenticate'
import { serviceArgs, spawnGitLimited } from '../app/Actions/Git/git'
import { stdoutStream } from '../app/Actions/Git/stream'
import { GATE_ENDPOINT, HOOK_ENDPOINT, hookSecret, repositoryByGitDir, repositoryPaths } from '../app/Actions/Git/hooks'
import { refsToExclude, reportLines, safeQuarantine, scanUpdate } from '../app/Actions/Git/scan'
import { instancePatterns, pushProtectionSettings } from '../app/Actions/Git/patterns'
import { decideBypass, readBypass } from '../app/Actions/Git/bypass'
import { auditEvent } from '../app/Audit/events'
import { auditFrom } from '../app/Actions/Git/audit'
import { decidePush, rulesFor } from '../app/Actions/Git/protection'
import { parseRefUpdates } from '../app/Actions/Git/push'
import { isAncestor } from '../app/Actions/Mirror/fetch'
import { gitService, parseGitUrl } from '../app/Actions/Git/storage'
import { handleRequest as handleLfsRequest } from 'ts-git-lfs'
import { actorFrom, DatabaseLockStore, endpointFor, storeFor } from '../app/Actions/Git/lfs'

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
/*
 * The git wire protocol, throttled generously.
 *
 * 300 a minute per credential. A clone is one request and a fetch is two, so a
 * person cannot reach this and a CI fleet on one token has to be trying. What it
 * stops is the case worth stopping: a loop that re-clones in a retry, which
 * costs a `git upload-pack` per attempt and is the most expensive thing an
 * unauthenticated-looking request can ask this server to do.
 *
 * The internal gate and hook endpoints below are deliberately *not* throttled.
 * They are called by scripts this server wrote into the repository, once per
 * push, and a limit there would refuse a legitimate push under load - which
 * fails the push rather than protecting anything.
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

  // The repository is named as the service's own argument, not as `.`. See the
  // note on `streamService`: these commands resolve their positional argument
  // themselves and ignore `--git-dir`, so `.` advertised the refs of whatever
  // directory the server process happened to be running in.
  const child = await spawnGitLimited('heavy', auth.path, serviceArgs(auth.path, service, { advertiseRefs: true }))

  if (!child)
    return saturated()

  // The advertisement preamble, then git's own output pulled one chunk at a
  // time (`stdoutStream`): a slow client slows git rather than filling this
  // process with the difference.
  const preamble = new TextEncoder().encode(`${packetLine(`# service=git-${service}\n`)}0000`)
  const advertisement = stdoutStream(child).getReader()

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(preamble)
    },
    async pull(controller) {
      const { done, value } = await advertisement.read()

      if (done)
        controller.close()
      else
        controller.enqueue(value)
    },
    cancel(reason) {
      void advertisement.cancel(reason)
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
}).skipCsrf().middleware('throttle:300,1m')

/** Fetch and clone. */
route.post('/{owner}/{repository}/git-upload-pack', async (request: any) => {
  const auth = await authorize(request, 'upload-pack')
  if (!auth.ok)
    return unauthorized(auth.status)

  return streamService(request, auth.path, 'upload-pack')
}).skipCsrf().middleware('throttle:300,1m')

/** Push. */
route.post('/{owner}/{repository}/git-receive-pack', async (request: any) => {
  const auth = await authorize(request, 'receive-pack')
  if (!auth.ok)
    return unauthorized(auth.status)

  return streamService(request, auth.path, 'receive-pack')
}).skipCsrf().middleware('throttle:300,1m')

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

  const path = repositoryPaths(gitDir).absolute
  const refused: Array<{ ref: string, reason: string }> = []

  // Branch rules first. They are a database read and an occasional
  // `merge-base`, where the scan below reads the patch of every commit - and a
  // push that is going to be refused for touching a protected branch should be
  // refused before anything expensive happens.
  const rules: any[] = await db
    .selectFrom('protected_branches')
    .select(['pattern', 'allow_force_push', 'allow_deletion'])
    .where('repository_id', '=', Number(repository.id))
    .execute()

  /*
   * Whether this repository is a mirror, which refuses pushes on its own.
   *
   * Read unconditionally, and `decidePush` is called unconditionally below.
   * Both were previously behind `rules.length > 0`, and a mirror with no branch
   * rules - which is every mirror, since nobody writes protection rules for a
   * copy - would have skipped the check entirely and accepted a push that the
   * next sync silently discards.
   */
  const mirror: any = await db
    .selectFrom('repository_mirrors')
    .select(['enabled', 'allow_local_pushes'])
    .where('repository_id', '=', Number(repository.id))
    .executeTakeFirst()

  const judged = []
  for (const update of updates) {
    // Only asked when a rule could refuse it, because it costs a git process
    // per ref and most pushes are covered by no rule at all. A mirror needs no
    // such question: it refuses whether or not history was dropped.
    const forced = update.change === 'updated' && rules.length > 0 && rulesFor(rules, update.name).length > 0
      ? !(await isAncestor(path, update.before, update.after))
      : false

    judged.push({ update, isForced: forced })
  }

  refused.push(...decidePush(rules, judged, { mirror: mirror ?? null }).refused)

  if (refused.length > 0)
    return new Response(JSON.stringify({ ok: false, refused }), { headers: { 'Content-Type': 'application/json' } })

  // Push protection. Scanning after the fact is a cleanup procedure: by then
  // the credential is in the reflog, in every clone, and possibly in a mirror.
  // This is the one moment where refusing prevents anything.
  const settings = await pushProtectionSettings()
  if (!settings.enabled)
    return allow()

  const protection = await scanPushed(payload, path, repository, updates)
  if (protection.length === 0)
    return allow()

  // Somebody has looked at a finding and decided it is wrong. The bypass is
  // easy to use and impossible to use quietly - see `app/Actions/Git/bypass`.
  const bypass = decideBypass(readBypass(payload?.pushOptions ?? []), settings)

  if (bypass.allowed) {
    const token = await tokenFromBasicAuth(request.headers?.get?.('authorization') ?? null)

    // Over HTTPS the pusher is whoever the Authorization header names. Over SSH
    // there is no header: the identity came from a key, and the daemon put it
    // in the hook's environment. Without this an SSH bypass is recorded against
    // nobody, which is the one thing the audit trail exists to prevent.
    const actorId = token?.userId ?? (payload?.actorId ? Number(payload.actorId) : null)

    await auditEvent('push:protection-bypassed', {
      subject: { type: 'repository', id: Number(repository.id) },
      actorId: Number.isFinite(actorId as number) ? actorId : null,
      // The token, the address and the user agent in one line. A push over HTTP
      // is always a token and never a session, so the first of those is what
      // says *which* credential overrode the protection.
      ...await auditFrom(request),
      // Scope, so this shows up when the repository's organization owner asks
      // what happened rather than only when an instance administrator does.
      repositoryId: Number(repository.id),
      organizationId: repository.owner_type === 'organization' ? Number(repository.owner_id) : null,
      reason: bypass.reason,
      detail: {
        refs: protection.map(one => one.ref),
        findings: protection.map(one => one.reason),
      },
    })

    return allow({ bypassed: true })
  }

  // A refusal that does not say what to do next is the one that turns into
  // "just disable the scanner".
  const help = bypass.message
    || (settings.allowBypass
      ? 'If this is not a credential: git push -o secret-scan=bypass -o reason="why"'
      : 'Push protection cannot be bypassed on this instance.')

  return new Response(
    JSON.stringify({ ok: false, refused: [...protection, { ref: '', reason: help }] }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}).skipCsrf()

/**
 * Scan what a push is carrying, and say what has to be taken out.
 *
 * Returns one entry per ref, because git reports a refusal per ref and a push
 * of three branches where one carries a key should name that branch.
 *
 * Nothing here can fail the push by accident: a scan that throws returns no
 * findings, which allows. Refusing a push because the scanner broke would be
 * the surest way to have the scanner turned off.
 */
async function scanPushed(
  payload: any,
  path: string,
  repository: any,
  updates: ReturnType<typeof parseRefUpdates>,
): Promise<Array<{ ref: string, reason: string }>> {
  if (repository.push_protection === false)
    return []

  try {
    // The quarantine, forwarded by the hook. Without it none of the pushed
    // objects are readable from this process and the scan silently finds
    // nothing - see `app/Actions/Git/scan.ts`.
    const quarantine = safeQuarantine(payload?.quarantine, path)
    const creating = updates.filter(update => update.change === 'created')
    const excludeRefs = creating.length > 0
      ? await refsToExclude(path, updates.map(update => update.ref), quarantine)
      : []

    const refused: Array<{ ref: string, reason: string }> = []

    for (const update of updates) {
      // A deletion introduces no content, and the one push that must always be
      // allowed is the one that takes a secret out.
      if (update.change === 'deleted')
        continue

      const result = await scanUpdate(path, update.before, update.after, {
        quarantine,
        excludeRefs,
        extra: await instancePatterns(),
      })

      if (result.findings.length === 0)
        continue

      refused.push({
        ref: update.ref,
        reason: [
          `${update.name} carries what looks like a credential:`,
          ...reportLines(result.findings, result.truncated),
        ].join('\n'),
      })
    }

    return refused
  }
  catch {
    return []
  }
}

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

  // Noticed synchronously, because this response is the one moment the
  // pusher is guaranteed to be looking: the hook prints these lines and git
  // relays them to the terminal. Cheap - a few ancestor checks - and never
  // the reason a push report fails.
  let messages: string[] = []
  try {
    const repository: any = await repositoryByGitDir(gitDir)
    if (repository) {
      const openRows: any[] = await db
        .selectFrom('pull_requests')
        .select(['head_branch', 'head_sha'])
        .where('repository_id', '=', Number(repository.id))
        .where('state', '=', 'open')
        .execute()

      const ownerTable = repository.owner_type === 'organization' ? 'organizations' : 'users'
      const ownerRow: any = await db
        .selectFrom(ownerTable)
        .select(['handle'])
        .where('id', '=', Number(repository.owner_id))
        .executeTakeFirst()

      if (ownerRow?.handle) {
        const { stackOffersForPush } = await import('../app/Actions/Pull/stackDetect')
        messages = await stackOffersForPush({
          gitDir,
          ownerHandle: String(ownerRow.handle),
          repositoryName: String(repository.name),
          defaultBranch: String(repository.default_branch ?? 'main'),
          updates,
          openHeads: new Map(openRows.map(row => [String(row.head_branch), String(row.head_sha)])),
        })
      }
    }
  }
  catch {
    // An offer is a nicety; the push report is the job.
  }

  return new Response(JSON.stringify({ ok: true, updates: updates.length, messages }), {
    headers: { 'Content-Type': 'application/json' },
  })
}).skipCsrf()

/**
 * Pipe the request body into git and its output back out, without either side
 * being held in memory.
 *
 * The repository is named as `upload-pack`'s and `receive-pack`'s own argument,
 * and that is not a detail. Both take the repository as a positional argument
 * and resolve it themselves; they do **not** read `--git-dir`. Passing `.` -
 * which this did - made every request operate on the server process's current
 * working directory, which is the application's own checkout. So a clone of any
 * URL served the forge's source code, a clone of a *private* repository served
 * it too because the permission check passed on the repository that was asked
 * for and a different one was handed over, and a push wrote its refs into the
 * application's own repository.
 *
 * It went unnoticed because everything looked right: the permission checks are
 * correct, the streaming is correct, `git clone` succeeded, and the ref
 * advertisement matched what the same wrong command produced on the command
 * line.
 */
/**
 * The transfer classes are full and stayed full for the acquire timeout.
 *
 * A 503 with `Retry-After` is the polite refusal: git clients surface the
 * message and a scripted clone loop backs off rather than piling on. The
 * alternative - queueing the request unboundedly - is how saturation becomes
 * an OOM kill that takes the served requests down with it.
 */
function saturated(): Response {
  return new Response('The server is at its concurrent transfer limit. Try again shortly.\n', {
    status: 503,
    headers: { 'Retry-After': '30' },
  })
}

async function streamService(request: any, path: string, service: 'upload-pack' | 'receive-pack'): Promise<Response> {
  const child = await spawnGitLimited('heavy', path, serviceArgs(path, service))

  if (!child)
    return saturated()

  const body: ReadableStream | null = request.body ?? null
  if (body) {
    const reader = body.getReader()
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done)
          break

        // `write()` answering false means git is indexing slower than the
        // push is arriving. Await `drain` rather than writing on: without
        // this, a fast push of a large packfile buffers unboundedly in this
        // process while git catches up.
        if (!child.stdin.write(value))
          await new Promise<void>(resolveDrain => child.stdin.once('drain', resolveDrain))
      }
      child.stdin.end()
    }
    pump().catch(() => child.kill('SIGKILL'))
  }
  else {
    child.stdin.end()
  }

  // Pull-based (`stdoutStream`), so a slow client slows git rather than
  // filling this process with a packfile the network has not taken yet.
  return new Response(stdoutStream(child), {
    headers: {
      'Content-Type': `application/x-git-${service}-result`,
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    },
  })
}

/**
 * Git LFS.
 *
 * `git lfs` asks `/owner/repo.git/info/lfs/objects/batch`, under the same
 * prefix as the wire protocol and for the same reason - it is discovered from
 * the clone URL rather than configured.
 *
 * The protocol is `ts-git-lfs`. Everything below is the three things it will
 * not decide for a host: where the objects live, who may read and write them,
 * and where locks are kept. Permissions come from `mayUseService`, the same
 * function the wire protocol asks, because LFS is a way of reading a
 * repository's contents like any other and a second opinion about that is a
 * bug waiting for the two to disagree.
 */
/**
 * One handler for every LFS endpoint.
 *
 * `ts-git-lfs` works out which endpoint this is from the URL, so the routes
 * below only exist to tell this router which paths to send here. They are
 * listed explicitly rather than matched with a wildcard: the set is small and
 * fixed, and a wildcard under a repository path would swallow anything added
 * beside it later.
 */
async function lfs(request: any): Promise<Response> {
  const url = new URL(request.url)
  const parsed = parseGitUrl(url.pathname.replace(/\/info\/lfs(\/.*)?$/, ''))

  if (!parsed)
    return new Response('Not found', { status: 404 })

  const repository = await findRepositoryByPath(parsed.owner, parsed.name)
  if (!repository)
    return new Response('Not found', { status: 404 })

  const token = await tokenFromBasicAuth(request.headers?.get?.('authorization') ?? null)
  const userId = token?.userId ?? null

  // Read and write are asked separately, and answered by the same rule the wire
  // protocol uses: fetching an object is a read, uploading one is a write. A
  // second opinion about permissions is a bug waiting for the two to disagree.
  const mayRead = await mayUseService(repository, userId, 'upload-pack', token)
  const mayWrite = await mayUseService(repository, userId, 'receive-pack', token)

  if (!mayRead) {
    // The same reasoning as the wire protocol: a private repository answers 404
    // rather than 401, because a 401 confirms it exists.
    if (userId === null && repository.visibility === 'public') {
      return new Response('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git LFS"' },
      })
    }

    return new Response('Not found', { status: repository.visibility === 'public' ? 403 : 404 })
  }

  const user = userId === null
    ? null
    : await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst()

  const response = await handleLfsRequest(request, {
    objects: storeFor(parsed.owner, parsed.name),
    locks: new DatabaseLockStore(Number(repository.id)),
    endpoint: endpointFor(request, parsed.owner, parsed.name),
    authorize: () => ({ actor: actorFrom(user, mayWrite), read: mayRead, write: mayWrite }),
  })

  if (!response)
    return new Response('Not found', { status: 404 })

  // A client that has not authenticated and is refused must be told to
  // authenticate, not told no. `git lfs` tries anonymously first - it cannot
  // know whether a public repository needs a credential to push to - and it
  // treats 403 as final: the push fails with "you may not write to this
  // repository" without ever sending the credential it was holding. 401 with a
  // challenge is what makes it try again.
  //
  // Found by running the real client. Every test here sent credentials, so
  // every test passed.
  if (response.status === 403 && userId === null) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Git LFS"' },
    })
  }

  return response
}

/**
 * Git LFS.
 *
 * `git lfs` asks `/owner/repo.git/info/lfs/objects/batch`, under the same
 * prefix as the wire protocol and for the same reason: it is discovered from
 * the clone URL rather than configured.
 *
 * The protocol is `ts-git-lfs`. What lives here is the three things it will not
 * decide for a host - where the objects live, who may read and write them, and
 * where locks are kept.
 */
route.post('/{owner}/{repository}/info/lfs/objects/batch', lfs).skipCsrf()
route.get('/{owner}/{repository}/info/lfs/objects/{oid}', lfs).skipCsrf()
route.put('/{owner}/{repository}/info/lfs/objects/{oid}', lfs).skipCsrf()
route.post('/{owner}/{repository}/info/lfs/verify', lfs).skipCsrf()
route.post('/{owner}/{repository}/info/lfs/locks', lfs).skipCsrf()
route.get('/{owner}/{repository}/info/lfs/locks', lfs).skipCsrf()
route.post('/{owner}/{repository}/info/lfs/locks/verify', lfs).skipCsrf()
route.post('/{owner}/{repository}/info/lfs/locks/{id}/unlock', lfs).skipCsrf()
