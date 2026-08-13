import type { CLI } from '@stacksjs/types'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { CARD_HEIGHT, CARD_WIDTH, DEFAULT_CARD, renderCard } from '../Social/card'

/**
 * Render the social card to a PNG.
 *
 * A link to this site is rendered by whoever receives it from `og:image`, and
 * without one a `summary_large_image` card is a grey box with a URL in it.
 *
 * The card is HTML - the landing page's palette at a different size - so it is
 * drawn by a browser rather than by a canvas library. That is a dependency on
 * Chrome, and it is deliberately a dependency of *regenerating* the card rather
 * than of building or serving the site: the PNG is committed, and this command
 * runs when the copy changes.
 *
 * Chrome is driven over the DevTools Protocol directly. A automation library
 * would be tens of megabytes of dependency for one screenshot a year, and this
 * is two WebSocket messages.
 */

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
]

async function findChrome(): Promise<string | null> {
  for (const path of CHROME_CANDIDATES) {
    if (await Bun.file(path).exists())
      return path
  }

  return null
}

/** The DevTools endpoint, once Chrome has decided which port it took. */
async function endpointOf(port: number, deadlineMs: number): Promise<string | null> {
  const until = Date.now() + deadlineMs

  while (Date.now() < until) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/json/version`)
      const parsed: any = await answer.json()

      if (parsed?.webSocketDebuggerUrl)
        return String(parsed.webSocketDebuggerUrl)
    }
    catch {
      // Not listening yet. Chrome takes a moment on a cold profile.
    }

    await Bun.sleep(120)
  }

  return null
}

/** One round trip on the protocol, awaited by id. */
function send(socket: WebSocket, id: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      const message = JSON.parse(String(event.data))

      if (message.id !== id)
        return

      socket.removeEventListener('message', onMessage)

      if (message.error)
        reject(new Error(`${method}: ${message.error.message}`))
      else
        resolve(message.result)
    }

    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

export default function (cli: CLI) {
  cli
    .command('social:card', 'Render the Open Graph card to public/images/og.png')
    .option('--out <path>', 'Where to write the PNG', { default: 'public/images/og.png' })
    .action(async (options: { out?: string }) => {
      const chrome = await findChrome()

      if (!chrome) {
        console.error('No Chrome or Chromium found. Install one, or render the card elsewhere and commit the PNG.')
        process.exit(1)
        return
      }

      const profile = await mkdtemp(join(tmpdir(), 'reviewos-card-'))
      const html = renderCard(DEFAULT_CARD)
      const page = join(profile, 'card.html')

      await writeFile(page, html)

      /*
       * A throwaway profile, and the whole battery of flags that stop Chrome
       * doing anything but drawing. A shared profile would inherit whatever
       * zoom, theme or extension the person running this has, and the card is
       * supposed to look the same from any machine.
       */
      const child = Bun.spawn([
        chrome,
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-color-profile=srgb',
        '--force-device-scale-factor=1',
        'about:blank',
      ], { stdout: 'pipe', stderr: 'pipe' })

      // Chrome writes the port it actually took into the profile directory.
      let port = 0
      const until = Date.now() + 20_000

      while (Date.now() < until && !port) {
        const written = await Bun.file(join(profile, 'DevToolsActivePort')).text().catch(() => '')
        const first = written.split('\n')[0]?.trim()

        if (first && Number.isInteger(Number(first)))
          port = Number(first)
        else
          await Bun.sleep(120)
      }

      const cleanUp = async (): Promise<void> => {
        child.kill()
        await rm(profile, { recursive: true, force: true }).catch(() => {})
      }

      if (!port) {
        await cleanUp()
        console.error('Chrome started but never reported a debugging port.')
        process.exit(1)
        return
      }

      const endpoint = await endpointOf(port, 15_000)

      if (!endpoint) {
        await cleanUp()
        console.error('Chrome is listening but the DevTools endpoint never answered.')
        process.exit(1)
        return
      }

      const socket = new WebSocket(endpoint)

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new Error('could not connect to Chrome')), { once: true })
      })

      let id = 0
      const next = (): number => (id += 1)

      const target = await send(socket, next(), 'Target.createTarget', { url: 'about:blank' })
      const session = await send(socket, next(), 'Target.attachToTarget', { targetId: target.targetId, flatten: true })
      const sessionId = String(session.sessionId)

      // Flat sessions want the id on every message, and `send` does not know
      // about sessions, so the page half goes through its own small helper.
      const toPage = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
        const messageId = next()

        return new Promise((resolve, reject) => {
          const onMessage = (event: MessageEvent): void => {
            const message = JSON.parse(String(event.data))

            if (message.id !== messageId)
              return

            socket.removeEventListener('message', onMessage)

            if (message.error)
              reject(new Error(`${method}: ${message.error.message}`))
            else
              resolve(message.result)
          }

          socket.addEventListener('message', onMessage)
          socket.send(JSON.stringify({ id: messageId, sessionId, method, params }))
        })
      }

      await toPage('Emulation.setDeviceMetricsOverride', {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      })

      await toPage('Page.enable')
      await toPage('Page.navigate', { url: `file://${page}` })

      // Layout and paint, then a beat for the radial gradient. There is no
      // network here, so waiting on a load event would be waiting on nothing.
      await Bun.sleep(400)

      const shot = await toPage('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT, scale: 1 },
      })

      socket.close()
      await cleanUp()

      const out = options.out ?? 'public/images/og.png'
      await mkdir(join(out, '..'), { recursive: true }).catch(() => {})
      await Bun.write(out, Buffer.from(String(shot.data), 'base64'))

      const size = (await Bun.file(out).arrayBuffer()).byteLength

      console.log(`Wrote ${out} (${CARD_WIDTH}x${CARD_HEIGHT}, ${Math.round(size / 1024)} KB)`)
    })
}
