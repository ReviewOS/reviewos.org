import { appendFileSync } from 'node:fs'
import type { ActionReference } from './actionRef'
import { shellQuote } from './checkout'
import { artifactAction } from './artifactActions'

export interface NativeActionRuntime {
  baseUrl: string
  workspace: string
  signal?: AbortSignal
  job: any
  run: (command: string) => Promise<{ ok: boolean, exitCode: number }>
}

/** Compatibility actions use the forge's existing scoped services, like cache. */
export async function nativeAction(input: {
  reference: ActionReference
  defaultHost: string | null
  with: Record<string, unknown>
  runtime: NativeActionRuntime
  output: string
}): Promise<{ ok: boolean, reason: string } | null> {
  const { reference, runtime } = input
  if (reference.kind !== 'remote' || (reference.host ?? input.defaultHost) !== 'github.com' || reference.subdirectory)
    return null
  if (['actions/upload-artifact', 'actions/download-artifact'].includes(String(reference.repository)))
    return artifactAction({ kind: reference.repository === 'actions/upload-artifact' ? 'upload' : 'download',
      values: input.with, workspace: runtime.workspace, baseUrl: runtime.baseUrl,
      token: String(runtime.job.token ?? ''), output: input.output, signal: runtime.signal })
  if (reference.repository !== 'actions/checkout') return null
  const values = input.with
  const allowed = new Set(['repository', 'ref', 'token', 'fetch-depth', 'persist-credentials', 'clean', 'lfs', 'submodules'])
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) return { ok: false, reason: `Checkout input ${key} is not supported by the native adapter` }
  }
  const repository = String(values.repository ?? runtime.job.repository_full_name)
  const sha = String(runtime.job.run?.head_sha ?? '')
  const ref = String(values.ref ?? sha)
  if (!/^[a-f0-9]{40}$/.test(sha) || /[\r\n\0]/.test(ref))
    return { ok: false, reason: 'Native checkout requires a canonical source identity' }
  if (repository !== runtime.job.repository_full_name || ![sha, runtime.job.run?.ref, String(runtime.job.run?.ref ?? '').replace(/^refs\/heads\//, '')].includes(ref))
    return { ok: false, reason: 'Native checkout requires this job\'s exact repository and source commit' }
  const depth = Number(values['fetch-depth'] ?? 1)
  if (!Number.isSafeInteger(depth) || depth < 0) return { ok: false, reason: 'Checkout fetch-depth must be a nonnegative integer' }
  for (const key of ['persist-credentials', 'clean', 'lfs']) {
    if (values[key] !== undefined && !['true', 'false'].includes(String(values[key])))
      return { ok: false, reason: `Checkout ${key} must be a boolean` }
  }
  if (values.submodules !== undefined && !['true', 'false', 'recursive'].includes(String(values.submodules)))
    return { ok: false, reason: 'Checkout submodules must be a boolean or recursive' }
  // The bootstrap already authenticated and scoped origin. An action token is
  // never persisted or used to broaden its repository/lease authority.
  // A default action already has the bootstrap commit. Reusing it avoids a
  // second shallow negotiation; deeper/full history must still be fetched.
  // Checkout/reset/clean below always run, including after intervening steps.
  const commands = depth === 0
    ? ['if [ "$(git rev-parse --is-shallow-repository)" = true ]; then git fetch --quiet --unshallow origin; else git fetch --quiet origin; fi', `git fetch --quiet origin ${shellQuote(sha)}`]
    : depth === 1
      ? [`if [ "$(git rev-parse --verify HEAD 2>/dev/null)" = ${shellQuote(sha)} ] && git cat-file -e ${shellQuote(`${sha}^{commit}`)}; then :; else git fetch --quiet --depth 1 origin ${shellQuote(sha)}; fi`]
      : [`git fetch --quiet --depth ${depth} origin ${shellQuote(sha)}`]
  commands.push(`git checkout --quiet --force ${shellQuote(sha)}`)
  if (String(values.clean ?? true) !== 'false') {
    commands.push(`git reset --hard --quiet ${shellQuote(sha)}`, 'git clean -ffdx -e .reviewos-runner/')
  }
  if (String(values.lfs) === 'true') commands.push('git lfs pull')
  if (['true', 'recursive'].includes(String(values.submodules)))
    commands.push(`git submodule update --init${String(values.submodules) === 'recursive' ? ' --recursive' : ''}`)
  const result = await runtime.run(commands.join(' && '))
  if (result.ok && input.output) appendFileSync(input.output, `commit=${sha}\nref=${ref}\n`)
  return { ok: result.ok, reason: result.ok ? 'Checked out the exact source with native scoped Git' : `Native checkout exited ${result.exitCode}` }
}
