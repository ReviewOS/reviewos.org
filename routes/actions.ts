import { route } from '@stacksjs/router'
import { isMirrored, parseActionUrl } from '../app/Actions/Actions/store'
import { serviceArgs, spawnGitLimited } from '../app/Actions/Git/git'
import { stdoutStream } from '../app/Actions/Git/stream'
import { actionPath } from '../app/Actions/Actions/store'

/**
 * The transfer classes are full and stayed full for the acquire timeout.
 *
 * The same refusal the repository wire protocol gives, and it matters more
 * here than there: this is the endpoint a whole runner fleet fetches from at
 * the start of every job, so it is the most likely thing on the instance to
 * be asked for a hundred simultaneous `upload-pack`s. A 503 with `Retry-After`
 * makes a runner wait; queueing without bound makes the box fall over with
 * everybody's requests attached.
 */
function saturated(): Response {
  return new Response('The server is at its concurrent transfer limit. Try again shortly.\n', {
    status: 503,
    headers: { 'Retry-After': '30' },
  })
}

/**
 * The mirrored actions, served over the ordinary git protocol.
 *
 * This is the fleet-facing cache. A runner's origins map points
 * `github.com` at `https://this-instance/actions/github.com`, and everything
 * else about fetching an action stays exactly as it was - same git, same
 * shallow fetch, same sha verification. Ten runners then fetch from here
 * instead of from the internet, and an instance whose upstream is unreachable
 * keeps building.
 *
 * **Read-only, and unauthenticated on purpose.** What is here is public code
 * that was mirrored from a public host; it carries no repository's contents and
 * no user's data. Requiring a credential would mean every runner in a fleet
 * holding one to fetch things anybody can already download, which is more
 * secrets in more places for no gain.
 *
 * `git-receive-pack` is not served at all. A mirror that could be pushed to is
 * a supply chain with a hole in it: the whole value of mirroring
 * `actions/checkout` here is that what this serves is what upstream had.
 */

/** The `# service=...` banner that opens a smart-HTTP advertisement. */
function packetLine(payload: string): string {
  const length = (payload.length + 4).toString(16).padStart(4, '0')

  return `${length}${payload}`
}

/** The mirror this request is about, or null when it names nothing here. */
function mirrorFor(request: any): { path: string } | null {
  const parsed = parseActionUrl(new URL(request.url).pathname)

  if (!parsed)
    return null

  if (!isMirrored(parsed.host, parsed.repository))
    return null

  const resolved = actionPath(parsed.host, parsed.repository)

  return resolved.ok && resolved.path ? { path: resolved.path } : null
}

/**
 * The ref advertisement.
 *
 * A mirror that has not been made yet answers 404 rather than an empty
 * advertisement: "this instance does not have that action" is a sentence a
 * runner's git turns into a readable error, and an empty advertisement is one
 * it turns into "the reference does not exist", which sends somebody looking at
 * their workflow instead of at the mirror.
 */
route.get('/actions/{host}/{owner}/{repository}/info/refs', async (request: any) => {
  const url = new URL(request.url)
  const service = url.searchParams.get('service')

  if (service !== 'git-upload-pack')
    return new Response('Only fetching is served here', { status: 400 })

  const mirror = mirrorFor(request)

  if (!mirror)
    return new Response('No such mirrored action', { status: 404 })

  // `heavy`, exactly as the repository routes: an advertisement is cheap but
  // it is the front half of a transfer, and counting it is what keeps a fleet
  // from opening more of them than the box can finish.
  const child = await spawnGitLimited('heavy', mirror.path, serviceArgs(mirror.path, 'upload-pack', { advertiseRefs: true }))

  if (!child)
    return saturated()

  const preamble = new TextEncoder().encode(`${packetLine('# service=git-upload-pack\n')}0000`)
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
      'Content-Type': 'application/x-git-upload-pack-advertisement',
      // Same reason as the repository routes: a cached advertisement makes a
      // fetch quietly miss commits.
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
    },
  })
}).skipCsrf().middleware('throttle:300,1m')

/** The fetch itself. */
route.post('/actions/{host}/{owner}/{repository}/git-upload-pack', async (request: any) => {
  const mirror = mirrorFor(request)

  if (!mirror)
    return new Response('No such mirrored action', { status: 404 })

  const child = await spawnGitLimited('heavy', mirror.path, serviceArgs(mirror.path, 'upload-pack', { advertiseRefs: false }))

  if (!child)
    return saturated()

  // Streamed both ways. A packfile is larger than anything worth holding in
  // memory, and buffering it passes every test written against a small
  // repository and falls over on the first real one.
  const body = request.raw?.body ?? request.body

  if (body) {
    const reader = (body as ReadableStream<Uint8Array>).getReader()

    void (async () => {
      for (;;) {
        const { done, value } = await reader.read()

        if (done)
          break

        // Awaited when git pushes back, the same as the repository routes:
        // ignoring the return value buffers the difference between how fast
        // the request arrives and how fast git reads it.
        if (!child.stdin.write(Buffer.from(value)))
          await new Promise<void>(resolveDrain => child.stdin.once('drain', resolveDrain))
      }

      child.stdin.end()
    })()
  }
  else {
    child.stdin.end()
  }

  // Pull-based, so a slow runner slows git rather than filling this process
  // with a packfile the network has not taken yet.
  return new Response(stdoutStream(child), {
    headers: {
      'Content-Type': 'application/x-git-upload-pack-result',
      'Cache-Control': 'no-cache',
    },
  })
}).skipCsrf().middleware('throttle:300,1m')
