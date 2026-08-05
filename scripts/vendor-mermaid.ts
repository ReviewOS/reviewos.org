#!/usr/bin/env bun
/**
 * Bundle mermaid into `public/js/mermaid.js`.
 *
 * A diagram in a README has to be drawn in the browser: mermaid is a layout
 * engine, and there is no server-side form of it that does not mean running a
 * headless browser per page view. So the library ships as a static asset.
 *
 * **Vendored rather than loaded from a CDN**, and that is the whole reason this
 * script exists. A self-hosted forge is often on a network with no route out,
 * and on the ones that do have a route, a CDN tag means every reader of every
 * issue announces themselves to a third party. Neither is a trade a forge gets
 * to make on its users' behalf.
 *
 * **Committed rather than built on install.** The output is one file that
 * changes only when mermaid does, and committing it means a clone works with no
 * extra step. Re-run this after upgrading the dependency:
 *
 *     bun scripts/vendor-mermaid.ts
 *
 * The asset is fetched only by a page that actually contains a diagram - see
 * the loader in `resources/views/layouts/app.stx` - so its size is paid by the
 * pages that use it and by nothing else.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = dirname(import.meta.dir)
const entry = join(root, 'storage', 'framework', 'runtime', 'mermaid-entry.ts')
const output = join(root, 'public', 'js', 'mermaid.js')

await mkdir(dirname(entry), { recursive: true })
await mkdir(dirname(output), { recursive: true })

// The entry has to sit inside the project for `mermaid` to resolve, and it is
// three words long, so it is written rather than committed. `storage/framework/
// runtime` is the machine-local scratch directory the rest of the build uses.
await writeFile(entry, 'export { default } from \'mermaid\'\n')

const built = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  format: 'esm',
  minify: true,
})

await rm(entry, { force: true })

if (!built.success) {
  for (const message of built.logs)
    console.error(message)

  process.exit(1)
}

const [bundle] = built.outputs
if (!bundle) {
  console.error('mermaid produced no output')
  process.exit(1)
}

const code = await bundle.text()
await writeFile(output, code)

console.error(`wrote public/js/mermaid.js (${(code.length / 1024 / 1024).toFixed(2)} MB)`)
