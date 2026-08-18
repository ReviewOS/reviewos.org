/**
 * Whether a fork's pull request runs without somebody saying so.
 *
 * The last clause of the fork policy in [the threat
 * model](../../../docs/ci-threat-model.md), and the one every forge has been
 * breached over. A pull request from a fork is somebody else's code on machines
 * an operator provided. It already gets no secrets and no identity token, and it
 * already cannot supply the workflow it runs under - but it still spends the
 * fleet, and it still reaches whatever those machines reach.
 *
 * **The decision is the instance's, not the workflow's.** A workflow file cannot
 * opt out, because the file is in the repository and the risk is the operator's.
 */

export type ForkApprovalPolicy = 'first-time' | 'always' | 'never'

export interface ForkApprovalFacts {
  policy: ForkApprovalPolicy
  /** False for a fork's pull request; true for the repository's own code. */
  trusted: boolean
  /**
   * Whether this contributor has already had work land here.
   *
   * The question `first-time` asks. Somebody whose pull request has been merged
   * into this repository has been vouched for by a person with write access
   * once already, which is exactly the fact the setting is about.
   */
  contributedBefore: boolean
  /**
   * Whether they can push here anyway, in which case asking is theatre.
   *
   * Asked as the real permission rather than as a row in one table: the
   * repository's owner, an organization member with write, and somebody on a
   * team that was granted it can all push, and none of them is a collaborator
   * row. A check that missed them would hold the maintainer's own fork branch
   * and ask them to approve it.
   */
  collaborator: boolean
}

export type ForkApprovalVerdict =
  | { required: false, reason: string }
  | { required: true, reason: string }

/**
 * Does this run need a person before it starts?
 *
 * A trusted run never does: the code and the workflow are both the
 * repository's own, and its author could push to the branch this is about.
 */
export function forkApprovalVerdict(facts: ForkApprovalFacts): ForkApprovalVerdict {
  if (facts.trusted)
    return { required: false, reason: 'this run is the repository\'s own code' }

  if (facts.policy === 'never')
    return { required: false, reason: 'this instance runs a fork\'s pull request without approval' }

  /*
   * A collaborator's fork is still an untrusted run - the code is somebody
   * else's branch and stays that way for secrets and identity - but asking them
   * for permission to run it is theatre: they can push to this repository, and
   * a push runs without asking.
   */
  if (facts.collaborator)
    return { required: false, reason: 'this contributor can push here, so a push would run without asking' }

  if (facts.policy === 'always')
    return { required: true, reason: 'this instance asks before running any fork\'s pull request' }

  return facts.contributedBefore
    ? { required: false, reason: 'this contributor has had work merged here before' }
    : { required: true, reason: 'this is a first-time contributor, and this instance asks before running their code' }
}

/**
 * The facts the verdict needs, read once per dispatch.
 *
 * Separated from the rule above so the rule can be tested against the awkward
 * cases - a collaborator's fork, a second-time contributor, an instance that
 * asks about everybody - without a database.
 */
export async function forkApprovalFacts(input: {
  repositoryId: number
  actorId?: number | null
  trusted: boolean
}): Promise<ForkApprovalFacts> {
  const { setting } = await import('../../Ops/settings')
  const { db } = await import('@stacksjs/database')

  const policy = String(await setting('fork_run_approval').catch(() => 'first-time')) as ForkApprovalPolicy

  /*
   * A trusted run short-circuits before anything is read. Most runs are trusted,
   * and this is on the dispatch path.
   */
  if (input.trusted)
    return { policy, trusted: true, contributedBefore: false, collaborator: false }

  /*
   * No actor is treated as a first-time contributor rather than as a known one.
   * A run whose author this instance cannot name is not one to wave through, and
   * the safe direction here is asking a maintainer a question they can answer in
   * one click.
   */
  if (!input.actorId)
    return { policy, trusted: false, contributedBefore: false, collaborator: false }

  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'visibility', 'owner_type', 'owner_id'])
    .where('id', '=', input.repositoryId)
    .executeTakeFirst()
    .catch(() => undefined)

  const merged = await db
    .selectFrom('pull_requests')
    .select(['id'])
    .where('repository_id', '=', input.repositoryId)
    .where('author_id', '=', Number(input.actorId))
    .where('state', '=', 'merged')
    .executeTakeFirst()
    .catch(() => undefined)

  /*
   * "Can they push here" asked with the same function every page and endpoint
   * asks, rather than as a row in `repo_collaborators`: the repository's owner
   * is not a collaborator of their own repository, and neither is an
   * organization member with write access.
   */
  const { permissionOn } = await import('../Git/access')
  const { repositoryViewAccess } = await import('../Repo/forView')

  const canPush = repository
    ? repositoryViewAccess(
        repository as Parameters<typeof repositoryViewAccess>[0],
        Number(input.actorId),
        await permissionOn(repository as Parameters<typeof permissionOn>[0], Number(input.actorId)),
      ).can('repository:push')
    : false

  return {
    policy,
    trusted: false,
    contributedBefore: Boolean(merged),
    collaborator: canPush,
  }
}
