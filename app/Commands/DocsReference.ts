import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { Glob } from 'bun'
import { checkedVariables, envReads, parseEnvExample, renderConfiguration } from '../Docs/configuration'
import { declaredRoutes, renderApiReference, renderWebhookReference } from '../Docs/reference'

/**
 * Write the generated reference pages.
 *
 * Three files, all committed: `docs/api.md` from the OpenAPI document the
 * actions produce, `docs/webhooks.md` from the module the payloads are built
 * from, and `docs/configuration.md` from `.env.example` and the source that
 * reads it. Generated rather than written because a second description of the
 * same thing is the one that goes stale - an endpoint gains a parameter, the
 * page keeps the old list, and somebody spends an afternoon discovering the
 * docs are wrong rather than their request.
 *
 * `--check` writes nothing and exits non-zero when the committed copy has
 * drifted, which is what a test and a CI step use. Regenerating in CI and
 * committing the result would be a robot editing the repository; failing and
 * naming the command is a person's job that takes ten seconds.
 */
export default function (cli: CLI) {
  cli
    .command('docs:reference', 'Generate the API, webhook and configuration reference pages')
    .option('--check', 'Fail if the committed pages are out of date rather than rewriting them', { default: false })
    .action(async (options: { check?: boolean }) => {
      const spec = await Bun.file('storage/framework/api/openapi.json').json().catch(() => null)

      if (!spec) {
        console.error('No OpenAPI document. Run `buddy generate:openapi` first.')
        process.exit(1)
        return
      }

      /*
       * A fixed date in the generated output, deliberately.
       *
       * A timestamp of "now" makes every regeneration a diff, so the check
       * below could never pass twice and the pages would churn in every commit
       * that touched them. The date the *document* was generated is the honest
       * one and it only moves when the API does.
       */
      const at = `from OpenAPI ${spec.info?.version ?? '1.0.0'}`

      /*
       * This application's own routes, not every route in the process.
       *
       * The document carries the framework's defaults too - a git forge's
       * reference listing `Campaigns` and `Board columns` is 550 entries in
       * which the hundred somebody wants cannot be found.
       */
      const routeFiles = [
        { prefix: '/api', source: await Bun.file('routes/api.ts').text().catch(() => '') },
        { prefix: '/api', source: await Bun.file('routes/v1.ts').text().catch(() => '') },
        { prefix: '/api', source: await Bun.file('routes/users.ts').text().catch(() => '') },
        { prefix: '/api', source: await Bun.file('routes/notifications.ts').text().catch(() => '') },
        { prefix: '/api', source: await Bun.file('routes/attachments.ts').text().catch(() => '') },
      ]

      const routes = declaredRoutes(routeFiles)

      /*
       * Every file that could read a variable, so "read by" is a fact rather
       * than a sample. `app/`, `routes/` and `resources/`, not `config/`: the
       * config files carry the framework's defaults for services this product
       * does not use, and a configuration page listing Twilio and Vonage is one
       * nobody finishes.
       *
       * `resources/` earns its place - `SSH_CLONE_HOST` and `SSH_CLONE_USER`
       * are read by a component and by nothing under `app/`, so leaving views
       * out published them as variables nothing reads.
       */
      const readers: Array<{ path: string, source: string }> = []

      for (const directory of ['app', 'routes', 'resources']) {
        for await (const file of new Glob('**/*.{ts,stx}').scan({ cwd: directory })) {
          const path = `${directory}/${file}`

          // Not the generator itself. It names variables in its own comments to
          // explain why they are hard to find, and listing it as their reader
          // would be the page citing itself.
          if (path.startsWith('app/Docs/'))
            continue

          readers.push({ path, source: await Bun.file(path).text() })
        }
      }

      readers.sort((left, right) => left.path.localeCompare(right.path))

      const entries = parseEnvExample(await Bun.file('.env.example').text())

      const pages = [
        { path: 'docs/api.md', body: renderApiReference(spec, at, routes) },
        { path: 'docs/webhooks.md', body: renderWebhookReference(at) },
        {
          path: 'docs/configuration.md',
          // Its own provenance line: this page comes from `.env.example` and
          // the source, and claiming an OpenAPI version it has nothing to do
          // with is the sort of small lie a reader catches and then distrusts
          // the rest of.
          body: renderConfiguration(
            entries,
            envReads(readers, new Set(entries.map(entry => entry.name))),
            'from `.env.example` and the source that reads it',
            checkedVariables(await Bun.file('app/Ops/config.ts').text()),
          ),
        },
      ]

      let stale = 0

      for (const page of pages) {
        const existing = await Bun.file(page.path).text().catch(() => '')

        if (existing === page.body) {
          console.log(`unchanged  ${page.path}`)
          continue
        }

        if (options.check) {
          stale += 1
          console.error(`out of date  ${page.path}`)
          continue
        }

        await Bun.write(page.path, page.body)
        console.log(`written    ${page.path}`)
      }

      if (options.check && stale > 0) {
        console.error('\nRun `buddy docs:reference` and commit the result.')
        process.exit(1)
      }
    })
}
