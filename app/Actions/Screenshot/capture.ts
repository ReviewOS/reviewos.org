/**
 * Taking the pictures, with Bun's own webview.
 *
 * No Playwright, no Puppeteer, no headless Chrome download: `Bun.WebView` is in
 * the runtime this project already runs on, and it navigates, evaluates,
 * resizes and screenshots. For a tool whose entire job is "open five pages and
 * photograph them", a 400MB browser dependency to do it would be the tail
 * wagging the dog - and one more thing to keep current in CI.
 *
 * The two rules that make the output trustworthy rather than merely present:
 *
 * - **Nothing is captured until the page says it is ready.** A selector has to
 *   match, and only then does the settle window start. A screenshot tool that
 *   sleeps a fixed second and fires produces a library of spinners.
 * - **A failure is loud.** A page that never becomes ready is reported and the
 *   old picture is left alone, because a blank image quietly replacing a good
 *   one is worse than no new image at all.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { SCREENSHOT_DIRECTORY, type Shot, VIEWPORT } from './shots'

export interface CaptureResult {
  name: string
  ok: boolean
  path?: string
  bytes?: number
  width?: number
  height?: number
  reason?: string
  ms: number
}

/** Whether an instance is answering at this address. */
export async function instanceIsUp(base: string): Promise<boolean> {
  try {
    const answer = await fetch(base, { signal: AbortSignal.timeout(3000) })

    return answer.ok || answer.status < 500
  }
  catch {
    return false
  }
}

/**
 * The PNG's pixel size, read from the header.
 *
 * Recorded because a Retina capture is twice the viewport, and a reader of the
 * output should see the real number rather than assume the one that was asked
 * for.
 */
function pngSize(bytes: Uint8Array): { width: number, height: number } | null {
  // 8-byte signature, then a 4-byte length and the `IHDR` tag, then width and
  // height as big-endian 32-bit integers.
  if (bytes.byteLength < 24)
    return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Take one. */
export async function capture(shot: Shot, base: string, directory = SCREENSHOT_DIRECTORY): Promise<CaptureResult> {
  const started = Date.now()
  const width = shot.width ?? VIEWPORT.width
  const height = shot.height ?? VIEWPORT.height

  await mkdir(directory, { recursive: true })

  let view: any

  try {
    view = new (Bun as any).WebView({ url: `${base}${shot.path}`, width, height, headless: true })

    // Ready means the page said so, not that time passed.
    if (shot.waitFor) {
      const deadline = Date.now() + 30_000
      let ready = false

      while (Date.now() < deadline) {
        const found = await view
          .evaluate(`Boolean(document.querySelector(${JSON.stringify(shot.waitFor)}))`)
          .catch(() => false)

        if (found === true || found === 'true') {
          ready = true
          break
        }

        await Bun.sleep(250)
      }

      if (!ready) {
        return {
          name: shot.name,
          ok: false,
          reason: `nothing matched ${shot.waitFor} within 30s - the page did not become ready`,
          ms: Date.now() - started,
        }
      }
    }

    if (shot.settleMs)
      await Bun.sleep(shot.settleMs)

    if (shot.before)
      await view.evaluate(shot.before).catch(() => undefined)

    const blob = await view.screenshot()
    const bytes = new Uint8Array(await blob.arrayBuffer())

    // A PNG this small is a blank page or an error card, whatever the status
    // said. Refused rather than written over a good picture.
    if (bytes.byteLength < 5000) {
      return {
        name: shot.name,
        ok: false,
        reason: `the capture was ${bytes.byteLength} bytes, which is a blank page rather than a screenshot`,
        ms: Date.now() - started,
      }
    }

    const target = join(directory, `${shot.name}.png`)
    await Bun.write(target, bytes)

    const size = pngSize(bytes)

    return {
      name: shot.name,
      ok: true,
      path: target,
      bytes: bytes.byteLength,
      width: size?.width,
      height: size?.height,
      ms: Date.now() - started,
    }
  }
  catch (error) {
    return {
      name: shot.name,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    }
  }
  finally {
    try {
      view?.close()
    }
    catch {
      // A view that failed to construct has nothing to close.
    }
  }
}

/** Where the instance is, for the command and for a test. */
export function defaultBase(): string {
  return String(process.env.SCREENSHOT_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}
