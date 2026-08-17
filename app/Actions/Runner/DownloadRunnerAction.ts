import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The runner binary, served by the instance it talks to.
 *
 * An autoscaler's cloud-init needs a URL. Every alternative is worse: baking an
 * image means rebuilding it whenever the runner changes, a release download
 * means the fleet and the instance can be different versions, and copying the
 * file by hand is not a thing a machine that boots in forty seconds can do.
 *
 * Serving it from here makes the version question answer itself - the binary a
 * machine fetches is the one built for *this* instance - which matters because
 * the protocol has a version and a fleet that drifts from its control plane is
 * the thing the version header exists to catch.
 *
 * ## Public, deliberately
 *
 * No credential. The binary contains no secret, does nothing until it is given a
 * URL and a token, and is the same file for every instance running this version.
 * Requiring a credential would mean every cloud-init holding one *before* the
 * runner credential it is actually there to use, which is a second secret to
 * manage for no gain.
 *
 * ## Built, not bundled
 *
 * `buddy build:runner --target linux-x64` writes it. Absent, this answers 404
 * with the command rather than a blank page: an operator whose cloud-init is
 * failing on a download should be told the file was never built, not left
 * reading a stack trace on a machine that is about to be destroyed.
 */
export default new Action({
  name: 'DownloadRunner',
  description: 'The compiled runner binary for a fleet machine',
  method: 'GET',

  validations: {
    // Declared so the published reference can say what this takes: an
    // endpoint whose only input is undocumented is one somebody has to read
    // the source to call.
    target: { rule: schema.string() },
  },

  responses: {
    200: { description: 'The binary, as an octet stream.' },
    404: { description: 'This instance has not built a runner for that platform, and says which command builds it.' },
  },

  async handle(request: any) {
    const target = String(request.get('target') ?? 'linux-x64').trim()

    /*
     * The targets `build:runner` knows, matched exactly. A path from a request
     * that reaches the filesystem is the oldest hole there is, and an
     * allowlist is the only version of this check that cannot be clever-ed
     * around.
     */
    const known = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64']

    if (!known.includes(target))
      return response.json({ error: `Unknown target. The targets are: ${known.join(', ')}.` }, 404)

    const path = resolve('dist/runner', target, target === 'windows-x64' ? 'reviewos-runner.exe' : 'reviewos-runner')

    if (!existsSync(path)) {
      return response.json({
        error: `This instance has not built a runner for ${target}.`,
        // The command, because the person reading this is usually looking at a
        // failed cloud-init and has one guess left.
        fix: `Run \`./buddy build:runner --target ${target} --out dist/runner/${target}\` on the instance.`,
      }, 404)
    }

    return new Response(Bun.file(path), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(statSync(path).size),
        'Content-Disposition': `attachment; filename="reviewos-runner${target === 'windows-x64' ? '.exe' : ''}"`,
        /*
         * Cached, and for a long time. It changes when the instance is
         * upgraded, and a fleet scaling up by ten machines a minute should not
         * pull ninety megabytes ten times from an instance that is also serving
         * people.
         */
        'Cache-Control': 'public, max-age=3600',
      },
    })
  },
})
