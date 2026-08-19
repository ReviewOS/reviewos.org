/**
 * The rules a workflow program has to follow, and where each is enforced.
 *
 * A workflow written as a program has one failure mode YAML does not: it can
 * depend on something that is not the same twice. A clock read, a random
 * number, an environment variable, a directory listing - each produces a
 * document that differs between the machine that built it and the machine that
 * rebuilds it, and a graph that differs between two builds of the same commit
 * is a run nobody can reproduce and a diff nobody can review.
 *
 * Three layers, and the roadmap asks for exactly this split:
 *
 * - **The types**, which hand the author a builder and nothing else: no clock,
 *   no environment, no fetch. Most of the rule is simply not reachable.
 * - **This check**, which reads the source and names what it found, with the
 *   line. It is the lint rule the roadmap asks for, in the form this project
 *   can actually run today - pickier's rule set is a separate package with its
 *   own release, and a rule that lands in three weeks is a rule that did not
 *   help the person writing a workflow this afternoon.
 * - **The replay**, for what neither can see: build twice and compare. A
 *   program that reads something this check does not know about still produces
 *   two different documents, and two runs of the same input is the only test
 *   that catches all of it.
 */

export interface DeterminismProblem {
  line: number
  /** The text that is not allowed, as written. */
  found: string
  /** Why, and what to do instead. */
  reason: string
}

interface Rule {
  pattern: RegExp
  reason: string
}

/**
 * What a workflow program may not read.
 *
 * Named rather than derived: a denylist that tried to be clever about
 * expressions would either miss the obvious cases or refuse ordinary code, and
 * the obvious cases are the ones people actually write.
 */
const RULES: Rule[] = [
  {
    pattern: /\bDate\.now\s*\(/g,
    reason: 'a clock read makes a workflow that differs between two builds of the same commit. Use an expression the runner evaluates - `${{ github.run_id }}` - or write the value into the workflow.',
  },
  {
    pattern: /\bnew\s+Date\s*\(\s*\)/g,
    reason: 'the same as `Date.now()`: the document would carry the moment it was built.',
  },
  {
    pattern: /\bMath\.random\s*\(/g,
    reason: 'a random number means two builds of one commit produce two graphs. If a value must vary per run, let the run supply it.',
  },
  {
    pattern: /\bprocess\.env\b/g,
    reason: 'the environment of the machine that built the workflow is not the environment of the machine that runs it. Use `env:` on the job, or a variable this instance holds.',
  },
  {
    pattern: /\bfetch\s*\(/g,
    reason: 'a workflow that asks the network what shape to be is one that changes when somebody else deploys. Fetch it in a step, where the run can see that it happened.',
  },
  {
    pattern: /\breaddir(?:Sync)?\s*\(/g,
    reason: 'a directory listing depends on the checkout the build happened to have. List the packages in the program, or read a file that is in the repository.',
  },
  {
    pattern: /\bcrypto\.randomUUID\s*\(/g,
    reason: 'a fresh identifier per build is the definition of a graph that cannot be compared between two builds.',
  },
]

/**
 * Read a workflow program and say what would make it non-deterministic.
 *
 * Text rather than a syntax tree, deliberately: this runs in a CLI on a file
 * somebody is editing, the patterns above are unambiguous, and a parser that
 * refused a file it could not parse would refuse exactly the file somebody is
 * halfway through writing.
 *
 * Comments and strings are stripped first, because a rule that fired on the
 * word `Date.now()` inside an explanation of why not to use it is a rule people
 * work around by deleting the explanation.
 */
export function checkDeterminism(source: string): DeterminismProblem[] {
  const problems: DeterminismProblem[] = []
  const lines = withoutCommentsOrStrings(String(source ?? '')).split('\n')

  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0

      const match = rule.pattern.exec(line)

      if (match)
        problems.push({ line: index + 1, found: match[0], reason: rule.reason })
    }
  }

  return problems
}

/**
 * The source with its comments and string contents blanked, line count intact.
 *
 * Blanked rather than removed so a reported line number still points at the
 * line somebody is looking at.
 */
function withoutCommentsOrStrings(source: string): string {
  let out = ''
  let index = 0

  const blank = (text: string): string => text.replace(/[^\n]/g, ' ')

  while (index < source.length) {
    const rest = source.slice(index)

    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n')
      const chunk = end === -1 ? rest : rest.slice(0, end)

      out += blank(chunk)
      index += chunk.length
      continue
    }

    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/')
      const chunk = end === -1 ? rest : rest.slice(0, end + 2)

      out += blank(chunk)
      index += chunk.length
      continue
    }

    const quote = rest[0]

    if (quote === '\'' || quote === '"' || quote === '`') {
      let cursor = 1

      while (cursor < rest.length) {
        if (rest[cursor] === '\\') {
          cursor += 2
          continue
        }

        if (rest[cursor] === quote) {
          cursor += 1
          break
        }

        cursor += 1
      }

      const chunk = rest.slice(0, cursor)

      out += blank(chunk)
      index += chunk.length
      continue
    }

    out += rest[0]
    index += 1
  }

  return out
}

/**
 * Build it twice and compare.
 *
 * The layer neither the types nor the check can replace: a program that reads
 * something nobody thought of still produces two different documents, and this
 * is the test that notices. Cheap enough to run on every build, which is where
 * it belongs - a replay check nobody runs is a rule that exists on paper.
 */
export function replayMatches(build: () => string): { ok: boolean, reason: string } {
  const first = build()
  const second = build()

  if (first === second)
    return { ok: true, reason: 'two builds produced the same workflow' }

  const line = firstDifference(first, second)

  return {
    ok: false,
    reason: `two builds of this program produced different workflows, first differing at line ${line}. Something in it is not the same twice.`,
  }
}

/** Where two documents stop agreeing, for a message somebody can act on. */
function firstDifference(left: string, right: string): number {
  const a = left.split('\n')
  const b = right.split('\n')

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index])
      return index + 1
  }

  return 0
}
