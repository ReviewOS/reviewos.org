import { route } from '@stacksjs/router'
import { findRepositoryByPath, mayUseService, pushActorFor, servablePathFor, tokenFromBasicAuth } from '../app/Actions/Git/access'
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
import { GIT_MOUNT, gitService, parseGitUrl } from '../app/Actions/Git/storage'
import { handleRequest as handleLfsRequest } from 'ts-git-lfs'
import { actorFrom, blobObjectStore, DatabaseLockStore, endpointFor } from '../app/Actions/Git/lfs'

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

  // `servablePathFor`, not `diskPathFor`: a repository this node has not
  // materialized yet is a cache miss rather than a 404, and this is the line
  // that makes that true for every clone, fetch and push over HTTP.
  const path = await servablePathFor(parsed.owner, parsed.name)
  if (!path)
    return { ok: false as const, status: 404 }

  return { ok: true as const, path, repositoryId: Number(repository.id), userId }
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
/**
 * Every wire route, at the root and under `/git`.
 *
 * The root is what the API process has always served and what the tests drive.
 * It is not what a client can reach: on a deployed instance the page process
 * owns `/` and proxies to the API by prefix, so `GET /{owner}/{repo}.git/info/refs`
 * was answered with a rendered HTML page and `git clone` reported that the
 * repository did not exist. Every repository. Since the day it was deployed.
 *
 * So the same handlers answer under `GIT_MOUNT` too, which `config/server.ts`
 * proxies wholesale, and `parseGitUrl` takes the mount off so a handler cannot
 * tell which door it came through. The POSTs are already proxied by method -
 * the default rule sends every mutating verb to the API - but they are
 * registered here as well, because a client that clones from the mount posts
 * its pack to the mount.
 */
function wire(method: 'get' | 'post' | 'put', pattern: string, handler: any) {
  const registered = ['', GIT_MOUNT].map(prefix => (route as any)[method](`${prefix}${pattern}`, handler))

  /*
   * Both copies get whatever is chained on, which is the point: a `skipCsrf`
   * or a throttle applied to one door and not the other is a route that
   * behaves differently depending on how the client reached it - and the door
   * that would have been missed is the only one clients use.
   */
  const both = {
    skipCsrf() {
      for (const entry of registered)
        entry?.skipCsrf?.()

      return both
    },
    middleware(...args: any[]) {
      for (const entry of registered)
        entry?.middleware?.(...args)

      return both
    },
  }

  return both
}

wire('get', '/{owner}/{repository}/info/refs', async (request: any) => {
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

/**
 * The checkpoint bundle, over plain HTTP.
 *
 * What `bundle.checkpoint.uri` on the repository points at. A client that
 * speaks `bundle-uri` fetches this first and then asks `upload-pack` only for
 * what has landed since - which moves the expensive half of a clone off the
 * server and onto static storage, and is phase 15's clone storm answered
 * without a replica.
 *
 * **Authorized exactly like a fetch**, through the same `authorize` the wire
 * protocol uses. A checkpoint is the whole repository in one file, so serving
 * it more freely than `upload-pack` would make every private repository
 * readable by anybody who guessed the URL.
 *
 * A repository with no checkpoint answers 404, which is what a client that
 * asked speculatively should get - and it falls back to an ordinary clone.
 */
wire('get', '/{owner}/{repository}/bundles/checkpoint', async (request: any) => {
  const auth = await authorize(request, 'upload-pack')

  if (!auth.ok)
    return unauthorized(auth.status)

  const parsed = parseGitUrl(new URL(request.url).pathname)
  const repository = parsed ? await findRepositoryByPath(parsed.owner, parsed.name) : null

  if (!repository)
    return new Response('Not found', { status: 404 })

  const { latestCheckpoint } = await import('../app/Actions/Git/checkpoint')
  const { blobStore } = await import('../app/Actions/Git/blobs')

  const store = await blobStore()
  const checkpoint = await latestCheckpoint(Number(repository.id), store)

  if (!checkpoint)
    return new Response('No checkpoint', { status: 404 })

  const stream = await store.get(checkpoint.key)

  if (!stream)
    return new Response('No checkpoint', { status: 404 })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-git-bundle',
      'Content-Length': String(checkpoint.bytes),
      // A checkpoint is immutable at its sequence, but the URI is stable
      // across checkpoints - so it is revalidated rather than held.
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}).skipCsrf().middleware('throttle:300,1m')

/** Fetch and clone. */
wire('post', '/{owner}/{repository}/git-upload-pack', async (request: any) => {
  const auth = await authorize(request, 'upload-pack')
  if (!auth.ok)
    return unauthorized(auth.status)

  return streamService(request, auth.path, 'upload-pack', auth.repositoryId)
}).skipCsrf().middleware('throttle:300,1m')

/** Push. */
wire('post', '/{owner}/{repository}/git-receive-pack', async (request: any) => {
  const auth = await authorize(request, 'receive-pack')
  if (!auth.ok)
    return unauthorized(auth.status)

  /*
   * Who is pushing, handed to git so the pre-receive hook can hand it back.
   *
   * The hook is a separate process posting to a loopback endpoint, and it does
   * not forward this request's `Authorization` header - so without this the
   * gate has no idea who is pushing over HTTP. The SSH daemon has always set
   * the same variable (`app/Actions/Git/ssh.ts`); this is the other half, and
   * until it existed a push over HTTPS was an anonymous one as far as branch
   * restrictions and the bypass log were concerned.
   */
  return streamService(request, auth.path, 'receive-pack', undefined, {
    REVIEWOS_ACTOR_ID: auth.userId === null ? '' : String(auth.userId),
  })
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

  /*
   * What the WAL needs, filled in once the repository is known.
   *
   * The log is written *here*, in the gate, rather than at post-receive: the
   * whole point is that a push is written down before it is acknowledged, and
   * post-receive runs after git has already accepted it. Recorded on the way
   * out through `allow()`, so every path that lets a push through records it
   * and no path can be added later that forgets to.
   *
   * This and the record below it carry everything their write needs rather than
   * reaching for `repository`, which is declared *after* `allow` - and `allow()`
   * is called twice before that line runs. Naming it in there would be a
   * temporal dead zone waiting for whoever adds the next field.
   */
  let walTarget: { repositoryId: number, path: string, updates: ReturnType<typeof parseRefUpdates> } | null = null

  /*
   * An administrator's exemption that actually changed the answer, if one did.
   *
   * Filled in below and written on the way out through `allow()`, for the same
   * reason the log is: a push refused further down - by push protection, say -
   * never landed, and recording "protection was bypassed" for a push that never
   * happened would put a false alarm in the one place somebody looks when they
   * are already worried.
   */
  let adminBypass:
    | { refs: string[], reasons: string[], actorId: number | null, repositoryId: number, organizationId: number | null }
    | null = null

  const allow = async (extra: Record<string, unknown> = {}): Promise<Response> => {
    const recorded = await recordWal(walTarget, payload)

    // `required` and the log could not be written: the push is refused. This
    // is the deliberate inversion of the fail-open rule that governs branch
    // protection - see config/git-wal.ts for why the two want opposite
    // failure modes.
    if (recorded === 'failed') {
      return new Response(
        JSON.stringify({
          ok: false,
          refused: [{
            ref: '',
            reason: 'This instance requires every push to be written to its log before it is accepted, and the log could not be written. Nothing was lost; try again.',
          }],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }

    /*
     * The only trace such a push leaves.
     *
     * Everything else about it looks like an ordinary push, which is precisely
     * the problem: without this line, "the branch was protected and the history
     * was rewritten anyway" has no record anybody can find, and the exemption
     * becomes indistinguishable from a protection that was never really on.
     */
    if (adminBypass) {
      await auditEvent('branch:protection-admin-bypass', {
        subject: { type: 'repository', id: adminBypass.repositoryId },
        actorId: adminBypass.actorId,
        ...await auditFrom(request),
        repositoryId: adminBypass.repositoryId,
        organizationId: adminBypass.organizationId,
        detail: {
          refs: adminBypass.refs,
          // The refs alone do not say whether a branch was force pushed,
          // deleted, or written by somebody its restriction excludes, and those
          // are three different mornings.
          would_have_refused: adminBypass.reasons,
        },
      })
    }

    return new Response(
      JSON.stringify({ ok: true, ...extra }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

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

  // Everything the log needs is known now. A push refused below never reaches
  // `allow()` and so never becomes a row, which is what keeps `pending` to its
  // one meaning: allowed, and not yet confirmed to have landed.
  walTarget = { repositoryId: Number(repository.id), path, updates }

  // Branch rules first. They are a database read and an occasional
  // `merge-base`, where the scan below reads the patch of every commit - and a
  // push that is going to be refused for touching a protected branch should be
  // refused before anything expensive happens.
  const rules: any[] = await db
    .selectFrom('protected_branches')
    .select(['pattern', 'allow_force_push', 'allow_deletion', 'enforce_admins', 'push_restrictions'])
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

  /*
   * Who is pushing.
   *
   * Only asked when a rule could turn on the answer, because it is three
   * queries and the overwhelming majority of pushes are covered by no rule at
   * all. `enforce_admins` and `push_restrictions` are the two that need it -
   * the first to know whether this person could have removed the rule instead,
   * the second to match a handle and a set of team slugs.
   *
   * The id arrives on the hook's payload: SSH puts it there from the daemon's
   * environment, HTTP from `git-receive-pack` above. It is trusted for the same
   * reason the rest of the body is - the request carried the hook secret, so it
   * came from a hook this instance wrote and started.
   */
  const actorId = payload?.actorId ? Number(payload.actorId) : null
  const actor = rules.length > 0 && Number.isFinite(actorId as number)
    ? await pushActorFor(repository, actorId)
    : null

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

  const decided = decidePush(rules, judged, { mirror: mirror ?? null }, actor)

  /*
   * What the same push would have been told without the exemption.
   *
   * Computed only for an administrator on a rule that grants one, so it costs
   * nothing on any other push - and it is the only way to tell an exemption
   * that was *used* from one that merely exists. Recording every push by an
   * admin to an unbound branch would bury the one that mattered.
   *
   * Pure, and over the same judged updates, so it asks git nothing a second
   * time.
   */
  if (actor?.isAdmin) {
    const bound = decidePush(rules, judged, { mirror: mirror ?? null }, { ...actor, isAdmin: false })
    const skipped = bound.refused.filter(one => !decided.refused.some(also => also.ref === one.ref))

    if (skipped.length > 0) {
      adminBypass = {
        refs: skipped.map(one => one.ref),
        reasons: skipped.map(one => one.reason),
        actorId,
        repositoryId: Number(repository.id),
        // Scoped so this reaches the repository's organization owner, rather
        // than only an instance administrator.
        organizationId: repository.owner_type === 'organization' ? Number(repository.owner_id) : null,
      }
    }
  }

  refused.push(...decided.refused)

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

  /*
   * The push landed, so its log entry is no longer pending.
   *
   * Never fails the report: post-receive runs after git has accepted the
   * commits, and an entry left pending is exactly what the reconciler sweeps -
   * it compares pending rows against the repository's real refs and commits
   * or voids them. So the cost of missing this is a row that gets settled
   * later, which is the right cost for something on the acknowledged path.
   */
  try {
    const { commitLanded } = await import('../app/Actions/Git/wal')
    await commitLanded(gitDir, updates)
  }
  catch (error) {
    console.error('[wal] could not commit a landed push:', error)
  }

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
 * Write a push to the log, if this instance keeps one.
 *
 * Answers what the caller has to know: `skipped` when the log is off or there
 * is nothing to record, `recorded` when the row is written, and `failed` only
 * in `required` mode - because in `advisory` a failure is logged and the push
 * goes through, which is the entire difference between the two modes.
 */
async function recordWal(
  target: { repositoryId: number, path: string, updates: ReturnType<typeof parseRefUpdates> } | null,
  payload: any,
): Promise<'skipped' | 'recorded' | 'failed'> {
  const { walMode } = await import('../config/git-wal')
  const mode = walMode()

  if (mode === 'off' || !target || target.updates.length === 0)
    return 'skipped'

  try {
    const { recordPush, walUpdatesFrom } = await import('../app/Actions/Git/wal')
    const { safeQuarantine, refsToExclude } = await import('../app/Actions/Git/scan')

    const quarantine = safeQuarantine(payload?.quarantine, target.path)
    const updates = walUpdatesFrom(target.updates)

    // What the repository already reaches, so the bundle carries the push
    // rather than the history. The same exclusion the secret scan computes,
    // and for the same reason: without it the first push of a fork bundles
    // the entire upstream project.
    const excludeRefs = await refsToExclude(target.path, updates.map(update => update.ref), quarantine)

    const entry = await recordPush({
      repositoryId: target.repositoryId,
      repositoryPath: target.path,
      updates,
      quarantine,
      excludeRefs,
    })

    if (entry) {
      /*
       * The ledger follows the log, in that order and inside the same gate.
       *
       * The sequence has been won, so this is not a race for the right to
       * write - it is the compare half of compare-and-swap, checking that the
       * refs still hold what this push was accepted against. A conflict here
       * means somebody else moved the ref between the gate and now, and git
       * will refuse the push for the same reason a moment later.
       *
       * Never fatal to the push on its own: the WAL row is the truth, and a
       * ledger that fell behind is what the drift audit exists to find. A
       * ledger that *blocked* a push would make an index more authoritative
       * than the thing it indexes.
       */
      try {
        const { applyToLedger } = await import('../app/Actions/Git/refs')
        await applyToLedger(target.repositoryId, updates, entry.sequence)
      }
      catch (error) {
        console.error('[wal] the ledger could not be updated:', error)
      }

      return 'recorded'
    }

    console.error('[wal] the push produced no log entry')
  }
  catch (error) {
    console.error('[wal] could not record a push:', error)
  }

  // Reached only when the log could not be written. `advisory` says so and
  // lets the push through - it buys backup without adding a way for a push to
  // fail; `required` refuses, which is the guarantee an operator opted into.
  return mode === 'required' ? 'failed' : 'skipped'
}

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

/**
 * Answer a clone from the pack cache, or say no.
 *
 * Returns a response only on a hit; anything else - a request that is not a
 * plain clone, a miss, a store that errored - answers null and the caller runs
 * git exactly as it always did.
 *
 * The request body has to be read to decide, which is why this consumes it and
 * hands the bytes back through `request.cachedBody` for the caller to replay
 * into git on a miss. A clone request is a few hundred bytes of pkt-line; this
 * is not the streaming body that matters.
 */
async function servePackFromCache(request: any, repositoryId: number): Promise<Response | null> {
  try {
    const raw = await readRequestBody(request)

    if (!raw)
      return null

    const { packCacheKey, parseClone } = await import('../app/Actions/Git/packCache')
    const plan = parseClone(raw)

    if (!plan)
      return null

    const { blobStore } = await import('../app/Actions/Git/blobs')
    const store = await blobStore()
    const stream = await store.get(packCacheKey(repositoryId, plan)).catch(() => null)

    if (!stream)
      return null

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-git-upload-pack-result',
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        // Visible, so an operator can see the cache working rather than infer
        // it from a latency graph.
        'X-Pack-Cache': 'hit',
      },
    })
  }
  catch {
    // A cache that throws is a cache that is not used. Never a failed clone.
    return null
  }
}

/** The whole request body, once, remembered for whoever needs it next. */
async function readRequestBody(request: any): Promise<Uint8Array | null> {
  if (request.__reviewosBody instanceof Uint8Array)
    return request.__reviewosBody

  const body: ReadableStream | null = request.body ?? null

  if (!body)
    return null

  const bytes = new Uint8Array(await new Response(body).arrayBuffer())
  request.__reviewosBody = bytes

  return bytes
}

/**
 * Where this clone's pack would be cached, when it is one worth caching.
 *
 * Null for every request the parser does not recognise as a plain clone,
 * which is the same rule the read side uses - so the two cannot disagree
 * about what is cacheable.
 */
async function packCacheTarget(repositoryId: number, body: Uint8Array): Promise<{ put: (stream: ReadableStream<Uint8Array>) => Promise<unknown> } | null> {
  try {
    const { packCacheKey, parseClone } = await import('../app/Actions/Git/packCache')
    const plan = parseClone(body)

    if (!plan)
      return null

    const { blobStore } = await import('../app/Actions/Git/blobs')
    const store = await blobStore()
    const key = packCacheKey(repositoryId, plan)

    return { put: (stream: ReadableStream<Uint8Array>) => store.put(key, stream) }
  }
  catch {
    return null
  }
}

async function streamService(request: any, path: string, service: 'upload-pack' | 'receive-pack', repositoryId?: number, env: Record<string, string> = {}): Promise<Response> {
  /*
   * The pack cache, for the one shape a runner fleet produces: fifty jobs on
   * one commit sending fifty identical clone requests, each making git walk
   * the graph and compress a pack that is byte-for-byte the last one.
   *
   * Only `upload-pack`, only a request the parser fully understands as a
   * plain clone, and never a push. Everything else - a negotiated fetch, a
   * shallow or partial clone, anything unfamiliar - falls straight through to
   * git, which is the behavior this file has always had.
   */
  if (service === 'upload-pack' && repositoryId) {
    const cached = await servePackFromCache(request, repositoryId)

    if (cached)
      return cached
  }

  const child = await spawnGitLimited('heavy', path, serviceArgs(path, service), env)

  if (!child)
    return saturated()

  /*
   * The body, which the cache lookup above may already have consumed.
   *
   * A clone request is a few hundred bytes of pkt-line, so remembering it
   * costs nothing - and it has to be remembered, because a stream can only be
   * read once and git still needs it on a miss. A push is never read this way:
   * `receive-pack` skips the cache entirely, so its packfile still streams.
   */
  const remembered: Uint8Array | null = request.__reviewosBody ?? null
  const body: ReadableStream | null = remembered ? null : (request.body ?? null)

  if (remembered) {
    child.stdin.write(remembered)
    child.stdin.end()
  }
  else if (body) {
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

  /*
   * A miss that is cacheable fills the cache on the way out.
   *
   * `tee` so the client is never waiting on the store: it takes the bytes as
   * git produces them, and the cache's branch is drained in the background. A
   * failed write means the next identical clone misses too, which is the
   * correct cost of a cache that cannot be written.
   */
  if (service === 'upload-pack' && repositoryId && remembered) {
    const stored = await packCacheTarget(repositoryId, remembered)

    if (stored) {
      const [toClient, toCache] = stdoutStream(child).tee()

      void stored.put(toCache).catch(() => undefined)

      return new Response(toClient, {
        headers: {
          'Content-Type': `application/x-git-${service}-result`,
          'Cache-Control': 'no-cache, max-age=0, must-revalidate',
          'X-Pack-Cache': 'miss',
        },
      })
    }
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
    // The blob store rather than a directory, so LFS follows the same driver
    // as everything else. On a local instance the keys resolve to the paths
    // the objects already occupy.
    objects: blobObjectStore(parsed.owner, parsed.name),
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
wire('post', '/{owner}/{repository}/info/lfs/objects/batch', lfs).skipCsrf()
wire('get', '/{owner}/{repository}/info/lfs/objects/{oid}', lfs).skipCsrf()
wire('put', '/{owner}/{repository}/info/lfs/objects/{oid}', lfs).skipCsrf()
wire('post', '/{owner}/{repository}/info/lfs/verify', lfs).skipCsrf()
wire('post', '/{owner}/{repository}/info/lfs/locks', lfs).skipCsrf()
wire('get', '/{owner}/{repository}/info/lfs/locks', lfs).skipCsrf()
wire('post', '/{owner}/{repository}/info/lfs/locks/verify', lfs).skipCsrf()
wire('post', '/{owner}/{repository}/info/lfs/locks/{id}/unlock', lfs).skipCsrf()
