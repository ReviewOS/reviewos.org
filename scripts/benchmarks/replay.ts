/**
 * The real page, with a captured manifest served in place of the live one.
 *
 * ## Why this exists
 *
 * A diff of eighty thousand files takes this server about thirty seconds to
 * compute and stream, nearly all of it git. That is a fact about git and it is
 * measured directly, with `curl`, which has no browser in it:
 *
 *     time curl -s -o /dev/null "$SERVER/api/repos/pulls/diff/manifest?owner=…"
 *
 * What that number makes impossible is measuring the *client* on the same run,
 * because a browser driven from a script does not always live that long - on
 * the machine this was written on a headless renderer is killed after about
 * thirty seconds whatever the page is doing, `about:blank` included. A page
 * that spends its whole life waiting for git never gets to the part being
 * measured.
 *
 * So the two halves are measured separately, which is the honest structure
 * anyway: the server's time with no browser, and the client's time with no
 * server. This is the second half. Everything is proxied to the real instance
 * except the manifest, which is streamed from a file captured from that same
 * endpoint - the same records, byte for byte, at the speed of a disk.
 *
 * ## What it does not prove
 *
 * That the two work together. They demonstrably do at every size below this
 * one, and the failure mode of the concatenation would be a new one; but a run
 * that never happened is not a measurement, and this comment is the place that
 * says so.
 *
 * ## Using it
 *
 *     # capture, once
 *     curl -s "$SERVER/api/repos/pulls/diff/manifest?owner=o&repo=r&number=1" > kernel.ndjson
 *
 *     # then serve the page with it replayed
 *     bun scripts/benchmarks/replay.ts --capture kernel.ndjson --upstream http://127.0.0.1:3000
 *
 * and point a browser or `trace.ts` at the port it prints.
 */

import process from 'node:process'

const args = process.argv.slice(2)

function read(flag: string, fallback?: string): string | undefined {
  const at = args.indexOf(flag)

  return at >= 0 ? args[at + 1] : fallback
}

const capture = read('--capture')
const upstream = read('--upstream', 'http://127.0.0.1:3000')!
const port = Number(read('--port', '4402'))

if (!capture) {
  console.error('Usage: bun scripts/benchmarks/replay.ts --capture <manifest.ndjson> [--upstream http://127.0.0.1:3000] [--port 4402]')
  process.exit(1)
}

const file = Bun.file(capture)

if (!await file.exists()) {
  console.error(`No capture at ${capture}. Fetch one from the manifest endpoint first.`)
  process.exit(1)
}

/**
 * Headers a proxy must not pass along.
 *
 * `accept-encoding` and `content-encoding` are the two that matter and the two
 * that are easy to miss: forward the request's encoding preferences and the
 * upstream answers compressed, then copying `content-encoding` onto a body
 * `fetch` has already decompressed produces a response the browser cannot read.
 * The symptom is not an error - it is a page whose subresources never finish,
 * so the load event never fires and every measurement waits for a timeout.
 */
const skip = new Set([
  'host',
  'connection',
  'accept-encoding',
  'content-encoding',
  'content-length',
  'transfer-encoding',
])

function forwarded(headers: Headers): Headers {
  const out = new Headers()

  for (const [name, value] of headers) {
    if (!skip.has(name.toLowerCase()))
      out.set(name, value)
  }

  return out
}

Bun.serve({
  port,
  // The capture is tens of megabytes and a slow reader is the normal case here.
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname.includes('/diff/manifest')) {
      return new Response(Bun.file(capture), {
        headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
      })
    }

    const answer = await fetch(`${upstream}${url.pathname}${url.search}`, {
      method: request.method,
      headers: forwarded(request.headers),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    })

    return new Response(answer.body, { status: answer.status, headers: forwarded(answer.headers) })
  },
})

console.error(`replaying ${capture} over ${upstream} on http://127.0.0.1:${port}`)
