/**
 * The marketing catalog: features, use cases, and comparisons.
 *
 * One source, so the mega menu, the index pages, and the individual pages can
 * never disagree about what exists. A feature page that the menu does not link
 * to is a page nobody finds, and a menu entry with no page is a dead link;
 * both happen the moment this list is written down twice.
 *
 * Copy lives here rather than in the templates so the pages stay thin and the
 * wording can be reviewed in one place.
 */

export interface FeatureLink {
  slug: string
  name: string
  /** One line, used in the mega menu and the card grid. */
  summary: string
  icon: string
  /** Grouping in the mega menu. */
  group: 'Review' | 'Repositories' | 'Automation' | 'Operations'
}

export const FEATURES: readonly FeatureLink[] = [
  {
    slug: 'review-threads',
    name: 'Durable review threads',
    summary: 'Comments that follow the line through a rebase instead of vanishing.',
    icon: 'i-hugeicons-comment-01',
    group: 'Review',
  },
  {
    slug: 'stacked-pull-requests',
    name: 'Stacked pull requests',
    summary: 'Dependent changes that merge in order and retarget themselves.',
    icon: 'i-hugeicons-layers-01',
    group: 'Review',
  },
  {
    slug: 'agentic-review',
    name: 'Agentic review',
    summary: 'Coding agents as first-class authors and reviewers, with the audit trail to match.',
    icon: 'i-hugeicons-ai-brain-01',
    group: 'Review',
  },
  {
    slug: 'fast-diffs',
    name: 'Diffs that stay fast',
    summary: 'Rendered on the server, against the merge base, readable at a hundred files.',
    icon: 'i-hugeicons-git-compare',
    group: 'Review',
  },
  {
    slug: 'merge-strategies',
    name: 'Merge strategies and rules',
    summary: 'Merge, squash, or rebase, gated by approvals, threads, and checks.',
    icon: 'i-hugeicons-git-merge',
    group: 'Review',
  },
  {
    slug: 'git-hosting',
    name: 'Plain git hosting',
    summary: 'Ordinary bare repositories on your disk, driven by the git binary.',
    icon: 'i-hugeicons-folder-01',
    group: 'Repositories',
  },
  {
    slug: 'issues',
    name: 'Issues that link up',
    summary: 'One number sequence, closing keywords, and references that resolve.',
    icon: 'i-hugeicons-task-01',
    group: 'Repositories',
  },
  {
    slug: 'search',
    name: 'Search that reads like a query',
    summary: 'Qualifiers, quoting, and negation, parsed properly rather than by regex.',
    icon: 'i-hugeicons-search-01',
    group: 'Repositories',
  },
  {
    slug: 'checks',
    name: 'Checks from your own CI',
    summary: 'A status API your existing pipeline reports into, enforced at merge.',
    icon: 'i-hugeicons-checkmark-circle-02',
    group: 'Automation',
  },
  {
    slug: 'webhooks',
    name: 'Webhooks you can trust',
    summary: 'Signed, retried with backoff, and blocked from reaching your own network.',
    icon: 'i-hugeicons-webhook',
    group: 'Automation',
  },
  {
    slug: 'notifications',
    name: 'Notifications worth reading',
    summary: 'Every message says why it reached you, and a burst arrives as one.',
    icon: 'i-hugeicons-notification-01',
    group: 'Automation',
  },
  {
    slug: 'self-hosting',
    name: 'Self-hosting without a cluster',
    summary: 'One Postgres and one process. Scale the parts that need it, later.',
    icon: 'i-hugeicons-server-stack-01',
    group: 'Operations',
  },
  {
    slug: 'pages',
    name: 'Pages for every repository',
    summary: 'A docs folder is a documentation site. Push, and the site is the branch.',
    icon: 'i-hugeicons-global',
    group: 'Operations',
  },
]

export const FEATURE_GROUPS = ['Review', 'Repositories', 'Automation', 'Operations'] as const

/** The features in one mega-menu column. */
export function featuresIn(group: string): FeatureLink[] {
  return FEATURES.filter(feature => feature.group === group)
}

export function featureBySlug(slug: string): FeatureLink | undefined {
  return FEATURES.find(feature => feature.slug === slug)
}

export interface UseCase {
  slug: string
  name: string
  summary: string
  icon: string
}

export const USE_CASES: readonly UseCase[] = [
  {
    slug: 'ai-assisted-teams',
    name: 'Teams shipping agent-written code',
    summary: 'When most diffs are machine-authored, review is the only remaining control.',
    icon: 'i-hugeicons-ai-brain-01',
  },
  {
    slug: 'open-source',
    name: 'Open source maintainers',
    summary: 'Drive-by contributions, long-running forks, and a review queue you can keep up with.',
    icon: 'i-hugeicons-globe-02',
  },
  {
    slug: 'platform-teams',
    name: 'Platform and infrastructure teams',
    summary: 'A forge you operate yourself, on hardware you already have.',
    icon: 'i-hugeicons-server-stack-01',
  },
  {
    slug: 'regulated',
    name: 'Regulated and audited work',
    summary: 'Who approved what, against which commit, kept rather than inferred.',
    icon: 'i-hugeicons-shield-01',
  },
  {
    slug: 'large-changes',
    name: 'Large refactors and migrations',
    summary: 'Hundred-file diffs and dependent stacks, reviewed a piece at a time.',
    icon: 'i-hugeicons-layers-01',
  },
]

export function useCaseBySlug(slug: string): UseCase | undefined {
  return USE_CASES.find(useCase => useCase.slug === slug)
}

export interface Comparison {
  slug: string
  name: string
  /** What they are, in their own terms. Fairness is the point of these pages. */
  summary: string
}

export const COMPARISONS: readonly Comparison[] = [
  {
    slug: 'github',
    name: 'ReviewOS and GitHub',
    summary: 'The default, and what you give up or gain by leaving it.',
  },
  {
    slug: 'gitlab',
    name: 'ReviewOS and GitLab',
    summary: 'A whole DevOps platform, against a forge that does one thing.',
  },
  {
    slug: 'forgejo',
    name: 'ReviewOS and Forgejo',
    summary: 'Two self-hosted forges with different centres of gravity.',
  },
]

export function comparisonBySlug(slug: string): Comparison | undefined {
  return COMPARISONS.find(comparison => comparison.slug === slug)
}
