# Workflows as code

A workflow is usually a file. When it is a program, the graph is expressed by
ordinary control flow: twelve jobs over a list of packages is a loop rather than
twelve copies somebody keeps in step, and a shared step is a function rather
than a YAML anchor.

```ts
// .reviewos/workflows/ci.ts
import { defineWorkflow } from '@reviewos/workflow'

const packages = ['api', 'web', 'cli']

export default defineWorkflow(
  {
    name: 'CI',
    on: { push: { branches: ['main'] }, pullRequest: {} },
    concurrency: { group: 'ci-${{ github.ref }}', cancelInProgress: true },
  },
  (workflow) => {
    for (const name of packages) {
      workflow.job(`test-${name}`, {
        reviewos: { 'if-changed': `packages/${name}/**` },
        steps: [
          { uses: 'actions/checkout@v4' },
          { name: 'Test', run: `bun test packages/${name}` },
        ],
      })
    }

    // The thing YAML cannot say: everything above, without a list to maintain.
    workflow.job('release', {
      needs: workflow.ids(),
      environment: 'production',
      steps: [{ run: './release.sh' }],
    })
  },
)
```

```sh
buddy workflow:build .reviewos/workflows/ci.ts --out .reviewos/workflows/ci.yml
```

## It is a second front door, not a second product

The program emits **the same YAML this instance already reads**, and that is the
design rather than an implementation detail. The parser, the conformance table,
the extension rules and every refusal are shared, so a workflow written as a
program cannot quietly express something a workflow written as a file may not -
and the output is a file a person can read in a review, which is the difference
between a program that generates CI and a black box that runs it.

It follows that everything the YAML path refuses, this refuses too. A `block:`
gate with steps under it is an error in both, because it is the same check.

## Determinism, and where each rule is enforced

A program has one failure mode a file does not: it can depend on something that
is not the same twice. A graph that differs between two builds of one commit is
a run nobody can reproduce and a diff nobody can review.

Three layers, and each catches what the one before it cannot:

- **The types.** The builder is all an author is handed: no clock, no
  environment, no fetch. Most of the rule is simply not reachable.
- **The check**, at build time, which reads the source and names what it found
  with the line: `Date.now()`, `Math.random()`, `process.env`, `fetch()`,
  `readdirSync()`, `crypto.randomUUID()`. Comments and strings are ignored,
  because a rule that fires on an explanation of why not to use `Date.now()` is
  a rule people work around by deleting the explanation. **A file that reads one
  of these is refused, not warned.**
- **The replay.** The program is built twice and the two documents compared. A
  program that reads something nobody thought of still produces two different
  documents, and two builds of the same input is the only check that catches all
  of it.

The roadmap asks for the second layer as a lint rule so an author learns from
their editor rather than from a diverged run three weeks later. What exists
today is the build-time check with the same messages; the editor half arrives
when pickier's rule set carries it, and until then the refusal happens at the
moment somebody runs the build rather than at the moment they push.
