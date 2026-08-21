/**
 * Starter workflows, for a repository that has none.
 *
 * The empty state of the workflows page is where somebody decides whether CI
 * here is worth the afternoon. "No workflows are registered" is true and
 * useless; a file they can copy, that runs, is the difference between trying it
 * and closing the tab.
 *
 * **Every one of these is a real Actions workflow**, not a dialect. That is the
 * whole point: what somebody starts with here is a file they could paste into
 * GitHub tomorrow, which is what makes the promise about compatibility
 * something they can check rather than something they have to believe.
 *
 * They are also deliberately small. A starter that configures caching, matrix
 * builds and three linters is one somebody has to *edit before it works*, and
 * an editing task is a decision, and a decision is where people stop.
 */

export interface StarterTemplate {
  /** The key a request names, and the file name it suggests. */
  id: string
  name: string
  /** One line, saying what it does and when to reach for it. */
  description: string
  /** Where it should be written. */
  path: string
  /** What ecosystems it suits, for a page that wants to order them sensibly. */
  tags: string[]
  content: string
}

/**
 * The starters, in the order a page should show them.
 *
 * Ordered by how many repositories they suit rather than alphabetically: the
 * first one should be right for most people, and somebody who reads no further
 * than the first should still get something that works.
 */
export const STARTERS: StarterTemplate[] = [
  {
    id: 'node',
    name: 'Node',
    description: 'Install dependencies and run the test script, on every push and pull request.',
    path: '.github/workflows/ci.yml',
    tags: ['node', 'javascript', 'typescript'],
    content: `name: CI

on:
  push:
    branches: [main]
  pull_request:

# One run per branch: a push while the last one is still going replaces it
# rather than queueing behind it.
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm test
`,
  },
  {
    id: 'bun',
    name: 'Bun',
    description: 'Install with Bun and run the tests. The fastest starting point if the runner has Bun.',
    path: '.github/workflows/ci.yml',
    tags: ['bun', 'javascript', 'typescript'],
    content: `name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun install --frozen-lockfile
      - run: bun test
`,
  },
  {
    id: 'make',
    name: 'Make',
    description: 'Run `make test`. Suits anything with a Makefile, whatever language is underneath.',
    path: '.github/workflows/ci.yml',
    tags: ['make', 'c', 'go', 'rust', 'anything'],
    content: `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: make test
`,
  },
  {
    id: 'matrix',
    name: 'A version matrix',
    description: 'The same tests across several runtime versions, each reported separately.',
    path: '.github/workflows/ci.yml',
    tags: ['node', 'python', 'matrix'],
    content: `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      # One combination failing does not cancel the others, so a single
      # version's failure still tells you about the rest.
      fail-fast: false
      matrix:
        version: ['20', '22']
    steps:
      - run: ./scripts/test "\${{ matrix.version }}"
`,
  },
  {
    id: 'manual',
    name: 'A button to press',
    description: 'A workflow with inputs, started by hand from the workflows page or the API.',
    path: '.github/workflows/deploy.yml',
    tags: ['deploy', 'manual'],
    content: `name: Deploy

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Where to deploy
        required: true
        type: choice
        options: [staging, production]
      dry-run:
        description: Print what would happen and stop
        type: boolean
        default: true

# One deployment at a time, and a newer one waits rather than replacing a
# release halfway through.
concurrency:
  group: deploy-\${{ inputs.environment }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: ./scripts/deploy --env "\${{ inputs.environment }}" --dry-run "\${{ inputs.dry-run }}"
`,
  },
  {
    id: 'nightly',
    name: 'Nightly',
    description: 'A scheduled job, plus a button so you can run it without waiting until 3am.',
    path: '.github/workflows/nightly.yml',
    tags: ['schedule', 'cron'],
    content: `name: Nightly

on:
  schedule:
    - cron: '0 3 * * *'
  # Always pair a schedule with this: waiting until tomorrow to find out
  # whether you fixed it is not a debugging loop.
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/audit
`,
  },
  {
    id: 'pages',
    name: 'Pages',
    description: 'Build the documentation and publish it. Finds a `docs/` folder on its own; falls back to markdown in the root.',
    path: '.reviewos/workflows/pages.yml',
    tags: ['docs', 'pages', 'bunpress', 'stx'],
    content: `name: Pages

# Only the default branch. A site has an address strangers read, so a pull
# request must not be able to replace it - and the publisher enforces that too,
# independently of what this file says.
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # What to build, decided by what is in the tree rather than by a setting
      # somebody has to keep in sync with it:
      #
      #   docs/                    -> bunpress builds the docs site
      #   a bunpress config        -> bunpress builds the root's markdown
      #   pages/ or index.stx      -> stx builds the templates
      #   index.html               -> already built; published as it stands
      #
      # A repository with none of those is not a mistake and is not failed. It
      # is a repository that has no site, and this says so and stops.
      - name: Detect
        id: detect
        run: |
          if [ -d docs ]; then
            echo "builder=bunpress" >> "$GITHUB_OUTPUT"
            echo "dir=docs" >> "$GITHUB_OUTPUT"
          elif [ -f bunpress.config.ts ] || [ -f bunpress.config.js ] || [ -f .config/bunpress.ts ] || [ -f docs.config.ts ] || [ -f .config/docs.ts ]; then
            echo "builder=bunpress" >> "$GITHUB_OUTPUT"
            echo "dir=." >> "$GITHUB_OUTPUT"
          elif [ -d pages ] || [ -f index.stx ]; then
            echo "builder=stx" >> "$GITHUB_OUTPUT"
          elif [ -f index.html ]; then
            echo "builder=static" >> "$GITHUB_OUTPUT"
          else
            echo "builder=none" >> "$GITHUB_OUTPUT"
          fi

      - name: Nothing to publish
        if: steps.detect.outputs.builder == 'none'
        run: |
          echo "No site found. Pages looks for, in order:"
          echo "  a docs/ folder, a bunpress config, a pages/ folder or index.stx, or an index.html."
          exit 0

      - uses: oven-sh/setup-bun@v2
        if: steps.detect.outputs.builder != 'none' && steps.detect.outputs.builder != 'static'

      # bunpress needs no config to build a docs/ folder - it has defaults for
      # everything - so a repository that only has markdown gets a site. A
      # config in the tree is picked up automatically and decides the title,
      # the sidebar and the theme.
      - name: Build with bunpress
        if: steps.detect.outputs.builder == 'bunpress'
        run: bunx --bun bunpress build "\${{ steps.detect.outputs.dir }}" --outdir dist

      - name: Build with stx
        if: steps.detect.outputs.builder == 'stx'
        run: bunx --bun stx build --out dist

      - name: Use the committed site
        if: steps.detect.outputs.builder == 'static'
        run: mkdir -p dist && cp -R ./. dist/ 2>/dev/null || true

      # The contents of the output directory, not the directory itself: the
      # publisher expects index.html at the archive root and says so if it is
      # not there.
      - name: Package
        if: steps.detect.outputs.builder != 'none'
        run: tar -czf pages.tar.gz -C dist .

      # The name is the contract. ReviewOS publishes the artifact named
      # pages from a successful run on the source branch, and nothing else.
      - uses: actions/upload-artifact@v4
        if: steps.detect.outputs.builder != 'none'
        with:
          name: pages
          path: pages.tar.gz
`,
  },
]

/** One starter by id, or nothing when the id names none. */
export function starter(id: string): StarterTemplate | null {
  return STARTERS.find(template => template.id === String(id ?? '').trim().toLowerCase()) ?? null
}

/**
 * The starters, most relevant first for a repository's languages.
 *
 * A repository whose language this instance already measured
 * ([phase 6](../../../docs/todo/06-search-explore.md)) should not be offered a
 * Python matrix first. Nothing is hidden - a suggestion that removes options is
 * a suggestion that is wrong at somebody's expense - they are only reordered.
 */
export function startersFor(languages: readonly string[]): StarterTemplate[] {
  const wanted = languages.map(language => language.toLowerCase())

  if (wanted.length === 0)
    return [...STARTERS]

  return [...STARTERS].sort((one, two) => score(two, wanted) - score(one, wanted))
}

function score(template: StarterTemplate, languages: readonly string[]): number {
  return template.tags.filter(tag => languages.includes(tag)).length
}
