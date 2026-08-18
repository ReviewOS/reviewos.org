/**
 * What arrives with a repository's CI, and what will not run when it does.
 *
 * The workflow files come across untouched - they are in the git history, so
 * cloning brings them - and that is exactly why this exists. A file that copied
 * cleanly and does not run is the worst outcome of a migration: everything
 * looks moved, the first push is green in the file and red in reality, and
 * somebody spends a morning finding out which of forty keys this instance does
 * not implement.
 *
 * So the deliverable is the **report**, produced before the move rather than
 * after it: which workflows were found, which constructs the conformance suite
 * says will not run, which actions cannot be resolved from here, and which
 * `runs-on` labels no machine on this instance answers to.
 */

import { db } from '@stacksjs/database'
import { parseActionRef } from '../Runner/actionRef'
import { parseWorkflow } from '../Workflow/parse'

export interface WorkflowReport {
  path: string
  name: string
  /** Keys this instance does not implement, or implements differently. */
  differences: Array<{ key: string, status: string, behaviour: string }>
  /** Every `uses:` in the file, with whether this instance can resolve it. */
  actions: Array<{ uses: string, kind: string, resolvable: boolean, why: string }>
  /** Every `runs-on` label, and whether a machine here answers to it. */
  labels: Array<{ label: string, machines: number }>
  /** Why the file could not be read at all, when it could not. */
  error: string | null
}

export interface ImportReport {
  workflows: WorkflowReport[]
  /** One line per thing to do, in the order somebody would do them. */
  actions_needed: string[]
}

/**
 * Read a repository's workflows and say what will happen to them.
 *
 * Takes the files rather than reading git itself, so the same function serves
 * the import (which has just cloned) and a dry run before anybody moves
 * anything - which is what "before the move rather than after" means.
 */
export async function reportOnWorkflows(input: {
  repositoryId: number
  files: Array<{ path: string, source: string }>
}): Promise<ImportReport> {
  const labelsHere = await labelsOnThisInstance()
  const workflows: WorkflowReport[] = []
  const needed = new Set<string>()

  for (const file of input.files) {
    /*
     * Parsed twice, and both are wanted. The workflow parser says whether this
     * instance would register the file at all and carries the conformance
     * warnings it derives; the raw document is what a reader is asking about
     * when they want to know which of *their* keys behave differently.
     */
    const parsed = parseWorkflow(file.source, file.path)

    if (!parsed.ok || parsed.errors.length > 0) {
      workflows.push({
        path: file.path,
        name: '',
        differences: [],
        actions: [],
        labels: [],
        error: parsed.errors.map(one => String(one.message ?? one)).join('; '),
      })

      needed.add(`\`${file.path}\` will not register here: ${String(parsed.errors[0]?.message ?? parsed.errors[0])}`)
      continue
    }

    const document = readDocument(file.source)
    /*
     * The warnings the parser already produced, which are `differencesIn` run
     * over the same file - taken from there rather than recomputed, so this
     * report and the one on the workflows page can never disagree about what
     * behaves differently.
     */
    const differences = parsed.warnings.map(one => ({ key: String(one.key), status: String(one.status), behaviour: String(one.message) }))
    const actions = actionsIn(document)
    const labels = labelsIn(document).map(label => ({ label, machines: labelsHere.get(label) ?? 0 }))

    workflows.push({
      path: file.path,
      name: String(document.name ?? file.path.split('/').pop() ?? ''),
      differences,
      actions,
      labels,
      error: null,
    })

    for (const difference of differences.filter(one => one.status === 'unimplemented'))
      needed.add(`\`${difference.key}\` in \`${file.path}\` does not run here: ${difference.behaviour}`)

    for (const action of actions.filter(one => !one.resolvable))
      needed.add(`\`${action.uses}\` cannot be resolved from this instance as it stands: ${action.why}`)

    for (const label of labels.filter(one => one.machines === 0))
      needed.add(`No machine on this instance answers to \`${label.label}\`, so jobs asking for it will queue forever`)
  }

  return { workflows, actions_needed: [...needed] }
}

/** The YAML as a plain object, or an empty one: this is a report, not a gate. */
function readDocument(source: string): Record<string, any> {
  try {
    // `Bun.YAML.parse`, the same reader the workflow parser uses: a second YAML
    // implementation would eventually disagree with it about a file.
    const parsed = Bun.YAML.parse(source) as unknown

    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {}
  }
  catch {
    return {}
  }
}

/** Every `uses:` in a workflow, and whether this instance could fetch it. */
function actionsIn(document: Record<string, any>): WorkflowReport['actions'] {
  const found = new Map<string, WorkflowReport['actions'][number]>()
  const jobs = document.jobs && typeof document.jobs === 'object' ? document.jobs : {}

  for (const job of Object.values(jobs as Record<string, any>)) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      const uses = String(step?.uses ?? '').trim()

      if (!uses || found.has(uses))
        continue

      const reference = parseActionRef(uses)

      /*
       * Resolvable here means "this instance could get it", not "the policy
       * allows it": the policy is a runner's setting and can be changed in an
       * afternoon, where a reference this parser cannot read is a file that has
       * to be edited. Both are reported; only the second is a blocker.
       */
      found.set(uses, {
        uses,
        kind: reference.kind,
        /*
         * Resolvable means "this instance could fetch it as it stands".
         *
         * An unqualified `actions/checkout@v4` is not: this product refuses to
         * guess github.com, so without a default action host configured on the
         * runner it resolves to nothing. That is a line in the report with a
         * fix beside it rather than a red run on the first push - which is the
         * whole point of producing this before the move.
         */
        resolvable: reference.kind === 'local'
          || (reference.kind === 'remote' && Boolean(reference.host)),
        why: reference.kind === 'unknown'
          ? 'this is not a reference shape this instance reads'
          : reference.kind === 'remote' && !reference.host
            ? 'it names no host, so the runner needs a default action host configured'
            : reference.kind === 'container'
              ? 'container actions run only where the operator enabled them and a runtime exists'
              : 'it comes from the repository itself',
      })
    }
  }

  return [...found.values()]
}

/** Every label a job asks for, flattened out of the two shapes `runs-on` takes. */
function labelsIn(document: Record<string, any>): string[] {
  const labels = new Set<string>()
  const jobs = document.jobs && typeof document.jobs === 'object' ? document.jobs : {}

  for (const job of Object.values(jobs as Record<string, any>)) {
    const runsOn = job?.['runs-on']

    for (const label of Array.isArray(runsOn) ? runsOn : [runsOn]) {
      const text = String(label ?? '').trim()

      if (text)
        labels.add(text)
    }
  }

  return [...labels]
}

/**
 * How many machines answer to each label here.
 *
 * `runs-on: [self-hosted, gpu]` keeps meaning what it meant only if a machine
 * carries both, so the count is per label and the report says which one nothing
 * answers to - which is the difference between "queued" and "queued forever".
 */
async function labelsOnThisInstance(): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom('runners')
    .select(['labels'])
    .where('state', '=', 'active')
    .execute()
    .catch(() => [])

  const counts = new Map<string, number>()

  for (const row of rows) {
    for (const label of String(row.labels ?? '').split(/[\n,]/).map(one => one.trim()).filter(Boolean))
      counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return counts
}

/**
 * What comes across besides the files: variables, environments, secret names.
 *
 * A workflow without them is green in the file and red in the run, which is the
 * failure this exists to prevent - and the two halves are honestly different:
 *
 * - **Variables come across with their values.** They are not credentials, and
 *   the API that lists them returns them.
 * - **Secrets come across as names only, and cannot come across any other way.**
 *   No forge hands a secret's value back, ours included: the whole point of the
 *   feature is that it is write-only. So the import creates nothing and reports
 *   the list, because "you have eleven secrets to set" written down before the
 *   move is the difference between a planned afternoon and a broken deploy.
 * - **Environments come across with their protection**, since a deploy gate
 *   that silently did not move is a rule somebody believes is on.
 */
export interface SettingsImport {
  variables: Array<{ key: string, scope: string }>
  environments: Array<{ name: string, reviewers: number, wait_minutes: number }>
  /** Names only, always. */
  secrets_to_set: string[]
  problems: string[]
}

export interface GitHubCiReader {
  variables: () => Promise<Array<{ name: string, value: string }>>
  secretNames: () => Promise<string[]>
  environments: () => Promise<Array<{ name: string, wait_minutes: number, reviewers: number }>>
}

/**
 * Read a repository's CI settings from GitHub and write what may be written.
 *
 * The reader is injected so this is testable without a network and without a
 * token: the interesting behaviour is what gets created and what gets reported,
 * not the shape of somebody else's JSON.
 */
export async function importCiSettings(input: {
  repositoryId: number
  reader: GitHubCiReader
}): Promise<SettingsImport> {
  const result: SettingsImport = { variables: [], environments: [], secrets_to_set: [], problems: [] }

  try {
    for (const variable of await input.reader.variables()) {
      const key = String(variable.name ?? '').trim()

      if (!key)
        continue

      const existing = await db
        .selectFrom('workflow_variables')
        .select(['id'])
        .where('scope_type', '=', 'repository')
        .where('scope_id', '=', input.repositoryId)
        .where('key', '=', key)
        .executeTakeFirst()

      // An import that overwrote a value somebody set here would undo work on
      // the second run, and imports are re-run.
      if (!existing) {
        await db.insertInto('workflow_variables').values({
          scope_type: 'repository',
          scope_id: input.repositoryId,
          key,
          value: String(variable.value ?? ''),
        }).execute()
      }

      result.variables.push({ key, scope: 'repository' })
    }
  }
  catch (error) {
    result.problems.push(`variables could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    for (const environment of await input.reader.environments()) {
      const name = String(environment.name ?? '').trim()

      if (!name)
        continue

      const existing = await db
        .selectFrom('environments')
        .select(['id'])
        .where('repository_id', '=', input.repositoryId)
        .where('name', '=', name)
        .executeTakeFirst()

      if (!existing) {
        await db.insertInto('environments').values({
          repository_id: input.repositoryId,
          name: name.slice(0, 120),
          wait_minutes: Math.max(0, Math.min(43_200, Number(environment.wait_minutes) || 0)),
          branches: '',
          description: 'imported',
        }).execute()
      }

      /*
       * The reviewers are counted rather than mapped. An account on the forge
       * being moved from is not an account here until somebody links it, and an
       * environment whose reviewer list silently emptied is a gate that opens
       * itself - so the count goes in the report and a person appoints them.
       */
      result.environments.push({
        name,
        reviewers: Number(environment.reviewers) || 0,
        wait_minutes: Number(environment.wait_minutes) || 0,
      })

      if (Number(environment.reviewers) > 0)
        result.problems.push(`\`${name}\` had ${Number(environment.reviewers)} required reviewers there; appoint them here, or the gate opens itself`)
    }
  }
  catch (error) {
    result.problems.push(`environments could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    result.secrets_to_set = (await input.reader.secretNames()).map(one => String(one)).filter(Boolean)
  }
  catch (error) {
    result.problems.push(`secret names could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }

  return result
}

/**
 * A reader for GitHub's REST API, for the ordinary case.
 *
 * Separate from the function above so the tests exercise the decisions rather
 * than somebody else's JSON, and so an instance importing from Gitea or GitLab
 * can hand over a different reader without touching what happens to the result.
 */
export function githubCiReader(input: {
  owner: string
  name: string
  token: string
  base?: string
  fetcher?: typeof fetch
}): GitHubCiReader {
  const base = (input.base ?? 'https://api.github.com').replace(/\/+$/, '')
  const fetcher = input.fetcher ?? fetch

  const read = async (path: string): Promise<any> => {
    const answer = await fetcher(`${base}/repos/${input.owner}/${input.name}/${path}`, {
      headers: {
        'Authorization': `Bearer ${input.token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'reviewos-import',
      },
    })

    if (!answer.ok)
      throw new Error(`GitHub answered ${answer.status} for ${path}`)

    return answer.json()
  }

  return {
    variables: async () => {
      const body = await read('actions/variables?per_page=100')

      return Array.isArray(body?.variables) ? body.variables : []
    },
    secretNames: async () => {
      const body = await read('actions/secrets?per_page=100')

      return Array.isArray(body?.secrets) ? body.secrets.map((one: any) => String(one?.name ?? '')) : []
    },
    environments: async () => {
      const body = await read('environments?per_page=100')
      const rows = Array.isArray(body?.environments) ? body.environments : []

      return rows.map((one: any) => {
        const rules = Array.isArray(one?.protection_rules) ? one.protection_rules : []
        const wait = rules.find((rule: any) => String(rule?.type) === 'wait_timer')
        const reviewers = rules.find((rule: any) => String(rule?.type) === 'required_reviewers')

        return {
          name: String(one?.name ?? ''),
          wait_minutes: Number(wait?.wait_timer ?? 0),
          reviewers: Array.isArray(reviewers?.reviewers) ? reviewers.reviewers.length : 0,
        }
      })
    },
  }
}
