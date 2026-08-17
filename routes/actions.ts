import { route } from '@stacksjs/router'
import { isMirrored, parseActionUrl } from '../app/Actions/Actions/store'
import { serviceArgs, spawnGit } from '../app/Actions/Git/git'
import { actionPath } from '../app/Actions/Actions/store'

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

  const child = spawnGit(mirror.path, serviceArgs(mirror.path, 'upload-pack', { advertiseRefs: true }))

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(packetLine('# service=git-upload-pack\n')))
      controller.enqueue(new TextEncoder().encode('0000'))
      child.stdout.on('data', (chunk: any) => controller.enqueue(new Uint8Array(chunk)))
      child.stdout.on('end', () => controller.close())
      child.on('error', () => controller.close())
    },
    cancel() {
      child.kill('SIGKILL')
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

  const child = spawnGit(mirror.path, serviceArgs(mirror.path, 'upload-pack', { advertiseRefs: false }))

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

        child.stdin.write(Buffer.from(value))
      }

      child.stdin.end()
    })()
  }
  else {
    child.stdin.end()
  }

  const stream = new ReadableStream({
    start(controller) {
      child.stdout.on('data', (chunk: any) => controller.enqueue(new Uint8Array(chunk)))
      child.stdout.on('end', () => controller.close())
      child.on('error', () => controller.close())
    },
    cancel() {
      child.kill('SIGKILL')
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-git-upload-pack-result',
      'Cache-Control': 'no-cache',
    },
  })
}).skipCsrf().middleware('throttle:300,1m')
