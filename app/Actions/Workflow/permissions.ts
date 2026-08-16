/**
 * `permissions:` - what a run's token may do.
 *
 * Actions writes these in GitHub's vocabulary (`contents: write`,
 * `pull-requests: read`) and this instance has its own
 * ([`app/TokenScopes.ts`](../../TokenScopes.ts)), so the file's names are
 * translated rather than adopted. A workflow written for GitHub has to keep
 * meaning what it meant, and a scope this instance does not have must be
 * *recorded and refused* rather than quietly ignored - a token that silently
 * grants nothing for `packages: write` is a workflow that fails at the far end
 * with no explanation.
 *
 * **The default is read-only, and the default is what most workflows get.**
 * Actions' own default depends on an organization setting, which is a footgun
 * this instance declines to reproduce: a workflow that says nothing gets a
 * token that can read the repository and nothing else, on every instance,
 * forever. Anything more is asked for in the file where a reviewer can see it.
 *
 * Nothing here mints a token. That is the execution plane's job, and by the
 * threat model it happens after the fork check - a fork's pull request gets no
 * write-scoped token whatever its workflow declares.
 */

import type { RepositoryScope, TokenLevel } from '../../TokenScopes'

/** GitHub's permission keys, mapped onto this instance's scopes. */
const SCOPE_NAMES: Record<string, RepositoryScope> = {
  'contents': 'contents',
  'issues': 'issues',
  'pull-requests': 'pull_requests',
  'checks': 'checks',
  'statuses': 'checks',
  'administration': 'administration',
  // The webhook surface is one scope here rather than GitHub's split between
  // repository hooks and organization hooks: this instance has one.
  'repository-hooks': 'webhooks',
}

/**
 * Keys Actions defines that this instance has no scope for.
 *
 * Named rather than lumped in with typos, because the two need different
 * answers: `packages: write` is a real permission for a feature that does not
 * exist here, and the workflow's author deserves to be told that rather than
 * left wondering. A typo is a typo.
 */
const UNIMPLEMENTED = new Set([
  'actions',
  'attestations',
  'deployments',
  'discussions',
  'id-token',
  'models',
  'packages',
  'pages',
  'security-events',
])

export interface ResolvedPermissions {
  /** The scopes this job's token would carry, at the level granted. */
  granted: Partial<Record<RepositoryScope, TokenLevel>>
  /** Keys the workflow asked for that this instance cannot grant. */
  unsupported: string[]
  /** How the answer was reached, for a screen that has to explain it. */
  source: 'job' | 'workflow' | 'default'
}

/** The token every workflow gets when it says nothing: read the code, nothing else. */
export function defaultPermissions(): Partial<Record<RepositoryScope, TokenLevel>> {
  return { contents: 'read' }
}

/**
 * Read a `permissions:` block, in all three shapes Actions accepts.
 *
 * `read-all` and `write-all` are the blanket forms; `{}` is the deliberate
 * "nothing at all", which is a real and useful thing to write and must not be
 * confused with the key being absent. `null` means absent.
 */
export function permissionsFrom(value: unknown): { granted: Partial<Record<RepositoryScope, TokenLevel>>, unsupported: string[] } | null {
  if (value === undefined || value === null)
    return null

  if (typeof value === 'string') {
    const word = value.trim().toLowerCase()

    if (word === 'read-all')
      return { granted: everyScope('read'), unsupported: [] }

    if (word === 'write-all')
      return { granted: everyScope('write'), unsupported: [] }

    // Any other bare string is not a shape Actions defines. Read as "nothing",
    // which is the safe direction: a token that grants less fails visibly.
    return { granted: {}, unsupported: [] }
  }

  if (typeof value !== 'object' || Array.isArray(value))
    return null

  const granted: Partial<Record<RepositoryScope, TokenLevel>> = {}
  const unsupported: string[] = []

  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    const name = String(key).trim().toLowerCase()
    const scope = SCOPE_NAMES[name]
    const wanted = String(level ?? '').trim().toLowerCase()

    if (!scope) {
      if (UNIMPLEMENTED.has(name))
        unsupported.push(name)

      continue
    }

    // `none` is how a workflow drops one scope while keeping others, so it has
    // to be an absence rather than a level.
    if (wanted === 'none')
      continue

    if (wanted !== 'read' && wanted !== 'write')
      continue

    /*
     * The highest of the two when a key maps onto a scope another key also
     * maps onto - `statuses` and `checks` are one scope here. Taking the
     * highest matches what the workflow asked for: it wanted to write statuses,
     * and refusing because `checks: read` came first would break it.
     */
    granted[scope] = granted[scope] === 'write' ? 'write' : (wanted as TokenLevel)
  }

  return { granted, unsupported }
}

/**
 * What this job's token may do.
 *
 * **A job's `permissions:` replaces the workflow's rather than adding to it.**
 * That is Actions' rule and the trap in it: a workflow granting
 * `contents: write` and a job declaring only `issues: write` produces a job
 * that cannot write contents. Merging would be the friendlier reading and the
 * wrong one - it would hand a job powers its author took away.
 */
export function resolvePermissions(
  workflow: unknown,
  job: unknown,
): ResolvedPermissions {
  const fromJob = permissionsFrom(parseStored(job))

  if (fromJob)
    return { granted: fromJob.granted, unsupported: fromJob.unsupported, source: 'job' }

  const fromWorkflow = permissionsFrom(parseStored(workflow))

  if (fromWorkflow)
    return { granted: fromWorkflow.granted, unsupported: fromWorkflow.unsupported, source: 'workflow' }

  return { granted: defaultPermissions(), unsupported: [], source: 'default' }
}

/** Every repository scope at one level, for the `read-all` / `write-all` forms. */
function everyScope(level: TokenLevel): Partial<Record<RepositoryScope, TokenLevel>> {
  const granted: Partial<Record<RepositoryScope, TokenLevel>> = {}

  for (const scope of Object.values(SCOPE_NAMES))
    granted[scope] = level

  /*
   * `administration` is deliberately not in the blanket forms.
   *
   * `write-all` on GitHub does not grant administration either, and it is the
   * scope that can change branch protection and delete the repository. A
   * workflow that genuinely needs it can name it; nobody should get it by
   * writing two words.
   */
  delete granted.administration

  return granted
}

/** A column holds JSON; a parser hands back the object it already read. */
function parseStored(value: unknown): unknown {
  if (typeof value !== 'string')
    return value

  const text = value.trim()

  if (!text)
    return null

  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}
