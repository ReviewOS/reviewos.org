import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A git repository.
 *
 * Owned polymorphically: `owner_type` is `user` or `organization`, and
 * `owner_id` points into that table. A repository's URL is
 * `/{owner handle}/{name}`, so name is unique per owner rather than globally.
 *
 * The counter columns are denormalised on purpose. A forge shows star and issue
 * counts on every listing, and counting rows for each one turns a repository
 * list into dozens of aggregate queries. Every writer updates the counter in
 * the same transaction as the row it counts.
 */
export default defineModel({
  name: 'Repository',
  table: 'repositories',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // Unique, not merely indexed. Every path that creates a repository under a
    // name - create, fork, rename, transfer - checks first that the name is
    // free, and every one of those checks is a read followed by a write with a
    // gap in between. Two requests arriving together both find the name free.
    // The constraint is what actually holds the rule; the checks exist to turn
    // it into a sentence rather than a database error.
    { name: 'repositories_owner_name_index', columns: ['owner_type', 'owner_id', 'name'], unique: true },
    { name: 'repositories_pushed_at_index', columns: ['pushed_at'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    /*
     * The index, declared where the model is.
     *
     * `shapeMany` rather than `shape`, because the two fields that make this
     * corpus worth searching - the owner's handle and the topics - are
     * relations, and asking for them one row at a time turns a rebuild into two
     * queries per repository. The batch form gets the whole chunk and spends
     * two queries on it however large it is.
     *
     * `searchable` is what a person types; `full_name` is in it because
     * "owner/name" is how a repository is said out loud, and somebody pasting
     * that should find it. What is deliberately *not* indexed is the rest of
     * the row - `disk_path`, the merge-strategy flags, `issue_counter` - which
     * the default projection used to include, at the cost of index size and a
     * write on every push, and which nobody has ever searched for.
     *
     * `visibility` is filterable and is not a permission boundary. See
     * `app/Actions/Search/visibility.ts`: the index is never trusted for that,
     * because it is a copy and a copy goes stale.
     */
    useSearch: {
      displayable: ['id', 'name', 'full_name', 'owner', 'description', 'topics', 'visibility', 'stars_count'],
      searchable: ['name', 'full_name', 'owner', 'description', 'topics'],
      sortable: ['stars_count', 'pushed_at', 'updated_at'],
      filterable: ['visibility', 'owner', 'topics', 'is_fork', 'is_archived'],
      shapeMany: async (rows: any[]) => {
        const { repositoryDocuments } = await import('../Actions/Search/documents')

        return await repositoryDocuments(rows)
      },
    },
    useSeeder: { count: 8 },
  },

  // A fork points at what it was forked from, and forks outlive their parent:
  // deleting a repository detaches its forks rather than taking them with it.
  // `app/Actions/Repo/purge.ts` does exactly this by hand today, which is the
  // application doing what the column can say for itself.
  //
  // Note this is the one relation here that is *not* declared for the sake of a
  // cascade - it is declared so a fork cannot point at a repository that is
  // gone, which nothing prevented before.
  belongsTo: [{ model: 'Repository', foreignKey: 'parent_id', relationName: 'parent', onDelete: 'set null' }],

  attributes: {
    owner_type: {
      order: 1,
      fillable: true,
      validation: { rule: schema.enum(['user', 'organization']) },
      factory: faker => faker.helpers.arrayElement(['user', 'organization']),
    },

    owner_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 4 }),
    },

    name: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().min(1).max(100) },
      factory: faker => faker.hacker.noun().toLowerCase(),
    },

    description: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().max(500) },
      factory: faker => faker.company.catchPhrase(),
    },

    visibility: {
      order: 5,
      fillable: true,
      default: 'public',
      validation: { rule: schema.enum(['public', 'private', 'internal']) },
      factory: faker => faker.helpers.arrayElement(['public', 'private']),
    },

    default_branch: {
      order: 6,
      fillable: true,
      default: 'main',
      validation: { rule: schema.string().max(255) },
      factory: () => 'main',
    },

    /** Where the bare repository lives, relative to the repository root. */
    disk_path: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(512) },
      factory: faker => `${faker.internet.username().toLowerCase()}/${faker.hacker.noun().toLowerCase()}.git`,
    },

    is_fork: {
      order: 8,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    parent_id: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    is_archived: {
      order: 10,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    is_template: {
      order: 11,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    size_kb: {
      order: 12,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 50000 }),
    },

    stars_count: {
      order: 13,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 500 }),
    },

    forks_count: {
      order: 14,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 50 }),
    },

    open_issues_count: {
      order: 15,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 40 }),
    },

    /**
     * Issues and pull requests share one sequence, so `#12` is unambiguous.
     * Allocated in the same transaction as the row it numbers.
     */
    issue_counter: {
      order: 16,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    pushed_at: {
      order: 17,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.recent().toISOString(),
    },

    /**
     * Which ways this repository lets a pull request land.
     *
     * Three booleans rather than a list, because a list has to be parsed and a
     * parse can fail - and a merge setting that fails open is a branch rule
     * that quietly stops applying. `required_checks` on `protected_branches`
     * is stored as JSON for a reason that does not apply here (the names are
     * arbitrary), and it needs a whole paragraph in the merge action about what
     * a malformed value means. A column per strategy needs none.
     *
     * All three on by default, which is what the product did before the setting
     * existed. Turning them all off is allowed and means nothing merges through
     * the interface, which is a legitimate thing to want on a mirror.
     */
    allow_merge_commit: {
      order: 18,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    allow_squash_merge: {
      order: 19,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    allow_rebase_merge: {
      order: 20,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    /**
     * The one the merge button offers first.
     *
     * Not enforced: a strategy that is the default but not allowed is a
     * misconfiguration, and the merge action refuses it like any other
     * disallowed strategy rather than silently substituting one. Silently
     * substituting is how somebody squashes a branch they meant to rebase.
     */
    default_merge_strategy: {
      order: 21,
      fillable: true,
      default: 'merge',
      validation: { rule: schema.enum(['merge', 'squash', 'rebase']) },
      factory: () => 'merge',
    },

    /**
     * Delete the head branch once its pull request lands.
     *
     * Off by default. Deleting somebody's branch is not recoverable through the
     * interface, and a repository that starts doing it because a default
     * changed is a repository that lost work it was never asked to lose. The
     * sha is on the merged pull request either way, so restoring one by hand is
     * always possible.
     */
    delete_branch_on_merge: {
      order: 22,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * Whether an approval from a machine account counts toward the required
     * approvals a branch rule demands.
     *
     * **Off by default**, and the default is the whole point. The failure mode
     * it prevents is a branch protected by a robot approving its own class of
     * change: an agent opens the pull request, another agent approves it, the
     * rule that said "two approvals" is satisfied, and nobody looked.
     *
     * A machine's *objection* is not affected. `changes_requested` from a
     * machine account blocks exactly as anyone else's does, because the two
     * directions are not symmetric - declining to count a robot's approval is
     * cautious, and ignoring a robot's objection is the opposite.
     *
     * Turning it on is a legitimate choice for a repository whose reviewing
     * agent is trusted and whose humans are the bottleneck. It has to be a
     * choice.
     */
    count_machine_approvals: {
      order: 23,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },
} as const)
