// The pictures, and the one thing a screenshot cannot do for itself.
//
// An image cannot fail: the interface moves, the picture stays, and nobody
// notices until somebody arrives from a link and finds the product does not
// look like its own website. These assertions are the substitute - that every
// declared shot exists, that none of them is the blank page a naive capture
// produces, and that the list and the directory agree.

import { describe, expect, test } from 'bun:test'
import { SCREENSHOT_DIRECTORY, SHOTS, VIEWPORT } from '../../app/Actions/Screenshot/shots'

/** Width and height out of the PNG header, which is where the truth is. */
async function pngSize(path: string): Promise<{ width: number, height: number, bytes: number } | null> {
  const file = Bun.file(path)

  if (!(await file.exists()))
    return null

  const bytes = new Uint8Array(await file.arrayBuffer())

  if (bytes.byteLength < 24)
    return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  return { width: view.getUint32(16), height: view.getUint32(20), bytes: bytes.byteLength }
}

describe('the declared shots', () => {
  test('name a page and say what the picture is for', () => {
    for (const shot of SHOTS) {
      expect(shot.path.startsWith('/')).toBe(true)
      // The purpose is what tells the next person whether their change breaks
      // this picture. A list of filenames does not.
      expect(shot.purpose.length).toBeGreaterThan(30)
    }
  })

  test('wait for something before the shutter opens', () => {
    // A tool that sleeps a fixed second and fires produces a library of
    // spinners. Every shot has to name what "ready" means for its page.
    for (const shot of SHOTS)
      expect(shot.waitFor && shot.waitFor.length > 0).toBe(true)
  })

  test('have unique names, since the name is the filename', () => {
    expect(new Set(SHOTS.map(shot => shot.name)).size).toBe(SHOTS.length)
  })
})

describe('the pictures on disk', () => {
  test('exist for every declared shot', async () => {
    const missing: string[] = []

    for (const shot of SHOTS) {
      if (!(await pngSize(`${SCREENSHOT_DIRECTORY}/${shot.name}.png`)))
        missing.push(shot.name)
    }

    expect(missing).toEqual([])
  })

  test('are not the blank page a failed capture writes', async () => {
    // The specific failure this guards: a page that returned 200, rendered
    // nothing, and was photographed anyway. Those come out tiny.
    const thin: string[] = []

    for (const shot of SHOTS) {
      const size = await pngSize(`${SCREENSHOT_DIRECTORY}/${shot.name}.png`)

      if (!size || size.bytes < 50_000)
        thin.push(`${shot.name} (${size?.bytes ?? 0} bytes)`)
    }

    expect(thin).toEqual([])
  })

  test('were taken at the declared viewport, at whatever density the display had', async () => {
    for (const shot of SHOTS) {
      const size = (await pngSize(`${SCREENSHOT_DIRECTORY}/${shot.name}.png`))!
      const width = shot.width ?? VIEWPORT.width

      // A Retina capture is an exact multiple of the viewport. Anything else
      // means the window was resized by something, and a picture at the wrong
      // aspect ratio is one that will be cropped badly wherever it is used.
      expect(size.width % width).toBe(0)
      expect(size.width / width).toBeLessThanOrEqual(3)
    }
  })
})
