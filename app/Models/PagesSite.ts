import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A repository's published site.
 *
 * One row per repository, and its absence is the answer for every repository
 * nobody has published: Pages is off. A `pages_enabled` column on
 * `repositories` would be false four thousand times to say something nobody
 * has decided.
 *
 * ## This row does not build anything
 *
 * It records **what is live**: which artifact, from which run, at which commit,
 * on which domain. The build happened on the execution plane, like every other
 * job, and its output arrived here as an artifact - the same path a release
 * binary takes.
 *
 * That is the only design the [threat model](../../docs/ci-threat-model.md)
 * permits. A documentation build evaluates repository code: a
 * `bunpress.config.ts` is a TypeScript module and an stx template evaluates
 * expressions. Running either inside the instance would put a docs config on
 * the same process as every private repository on the box, and "it is only the
 * docs" is exactly the sentence that precedes the incident. So Pages is a
 * publisher, never a builder, and it says so out loud when there is no
 * execution plane to build on.
 *
 * The exception needs no plane at all: a `static` source is HTML somebody
 * committed. It is copied and served, never run, so it publishes on an
 * instance with no runner of any kind.
 *
 * ## The artifact is provenance; the served copy is on disk
 *
 * Publishing extracts the archive to `storage/pages/<repository>/<sha>/` and
 * serves from there. `live_artifact_id` records which artifact it came out of,
 * so a wrong page can be traced to a run, but nothing reads the artifact per
 * request.
 *
 * Reading from the artifact directly would mean walking a tar to answer every
 * request for every file, and a documentation site is thousands of small files
 * - so the first page load would scan the archive a hundred times. It would
 * also break the moment the artifact expired, and an artifact's ninety days are
 * measured from the *build*, so the site that vanished would be the one whose
 * docs had stopped needing changes.
 */
export default defineModel({
  name: 'PagesSite',
  table: 'pages_sites',
  primaryKey: 'id',
  autoIncrement: true,

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  indexes: [
    // One per repository. Two published sites for one repository is a question
    // with two answers, and whichever the query ordered first would decide what
    // a visitor sees.
    { name: 'pages_sites_repository_index', columns: ['repository_id'], unique: true },
    // A request arrives as a Host header and has to become a site in one
    // lookup. Unique because a domain answered by two repositories is a
    // hijack, not a configuration.
    { name: 'pages_sites_domain_index', columns: ['domain'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * Whether the site is served at all.
     *
     * Off even with a row present, because a row is created by setting any
     * other field - and "this repository is on the public internet" must not
     * switch on as a side effect of naming a branch.
     */
    enabled: {
      order: 2,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * The branch whose runs may publish.
     *
     * Empty means the repository's default branch. Stated as a branch rather
     * than "any successful run", because a site is a thing with an address that
     * strangers read: a run on somebody's feature branch must not be able to
     * replace it.
     */
    source_branch: {
      order: 3,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(255) },
      factory: () => '',
    },

    /**
     * The custom domain, when there is one.
     *
     * Null means the site is reached at the instance's own Pages address. A
     * value here is a name whose DNS the owner controls and has pointed at this
     * instance; nothing is verified by writing it, and the serving path answers
     * 404 for a domain whose row is disabled rather than trusting the header.
     */
    domain: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => '',
    },

    /**
     * Who may read the site.
     *
     * `public` serves it to anybody. `repository` requires whatever reading the
     * repository requires, which for a private repository means a session - the
     * only setting under which publishing a private repository's docs is not
     * publishing the repository.
     *
     * Defaults to `repository` rather than `public`, and that asymmetry is
     * deliberate: the mistake that costs something is publishing a private
     * repository's internal documentation to the internet, not making somebody
     * click a switch to share it.
     */
    visibility: {
      order: 5,
      fillable: true,
      default: 'repository',
      validation: { rule: schema.enum(['public', 'repository']) },
      factory: () => 'repository',
    },

    /** The artifact currently served. Null until the first successful publish. */
    live_artifact_id: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The run that produced it, kept so a visitor's 500 has a build to read. */
    live_run_id: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The commit the live site was built from. */
    live_sha: {
      order: 8,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(64) },
      factory: () => '',
    },

    /** When it went live, which is the only date a visitor ever asks about. */
    live_at: {
      order: 9,
      fillable: true,
      validation: { rule: schema.date() },
      factory: () => null,
    },

    /**
     * Why the last publish did not happen, in a sentence.
     *
     * Stored rather than only logged. The failure a person meets is "my docs
     * did not update", and the answer - the run had no `pages` artifact, the
     * archive was too large, the branch was not the source branch - is a fact
     * about one attempt that has to survive until somebody looks at the
     * settings page.
     */
    last_error: {
      order: 10,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(500) },
      factory: () => '',
    },
  },
})
