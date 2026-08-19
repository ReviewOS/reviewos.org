/**
 * A workflow written as a program, made legible to a control plane that must
 * never run it.
 *
 * This is where phase 9's architectural decision becomes code. Cloudflare can
 * evaluate workflow code in their control plane because their control plane is
 * a Workers isolate and running untrusted code is what it is for. Ours is a Bun
 * process holding the database, the session keys, and every bare repository on
 * disk - so a repository's TypeScript is dispatched to a runner like any other
 * untrusted work, and **nothing here imports, transpiles, or evaluates a line
 * of it.**
 *
 * ## Then how does anything know when to run it?
 *
 * A workflow's triggers have to be readable *before* the workflow runs -
 * otherwise the only way to find out whether a program wanted to run on this
 * push is to run it, which is the thing that must not happen. So a program
 * declares them in a front matter block, in the same YAML the static form uses:
 *
 * ```ts
 * /* --- reviewos
 * name: Release
 * on:
 *   push:
 *     branches: [main]
 * --- *\/
 *
 * export default async function (workflow) {
 *   await workflow.step('build', () => ...)
 * }
 * ```
 *
 * The block is read as text and parsed as YAML. Everything below it is opaque -
 * bytes to be shipped to a machine, exactly like a `run:` script.
 *
 * ## One job, and the rest is the program's business
 *
 * The document synthesized here has a single job: the orchestrator. Its graph
 * is not known before dispatch - that is the entire reason a workflow would be
 * written as a program - so there is nothing else to write down. The jobs it
 * decides on arrive later as journaled `step()` calls, and become rows on the
 * same run.
 *
 * That is what makes the normalization real rather than claimed: this does not
 * produce a second kind of run, it produces an ordinary one whose first job
 * happens to be a program.
 */

/** The extensions a program may be written in. */
export function isProgramPath(path: string): boolean {
  return /\.(?:[cm]?ts|[cm]?js)$/i.test(String(path ?? ''))
}

/**
 * The front matter block, or null.
 *
 * Deliberately strict about where it may be: at the top of the file, before any
 * code. A block found anywhere would be a block that could be *generated*
 * anywhere, and reading configuration out of the middle of a program is one
 * step from evaluating the program to find it.
 */
export function frontMatterOf(source: string): string | null {
  const text = String(source ?? '')

  // Only the head of the file is searched. A "front matter" block ten thousand
  // lines down is not front matter.
  const head = text.slice(0, 8192)
  const match = head.match(/^\s*\/\*\s*---\s*reviewos\s*\n([\s\S]*?)\n\s*---\s*\*\//)

  return match?.[1] ?? null
}

/** What a program with no readable front matter is missing, in a sentence. */
export const MISSING_FRONT_MATTER
  = 'A workflow written as a program must declare its triggers in a front matter block at the top of '
    + 'the file, because the control plane has to know whether this workflow wanted to run before it '
    + 'runs anything. Start the file with `/* --- reviewos`, the same `name:` and `on:` you would '
    + 'write in YAML, and `--- *' + '/`.'

/**
 * The document this program's version is stored as.
 *
 * Returns YAML, so everything downstream - the parser, the version rows, the
 * trigger filters, the dispatch, the claim - is the code that already exists
 * and is already tested. A second pipeline for the second authoring form is
 * exactly the fork this design exists to avoid.
 */
export function programDocument(source: string, path: string): { ok: true, document: string } | { ok: false, error: string } {
  const front = frontMatterOf(source)

  if (front === null)
    return { ok: false, error: MISSING_FRONT_MATTER }

  /*
   * The front matter may not declare jobs.
   *
   * A program that also wrote a static graph would have two answers to "what
   * does this run" and no rule for which wins. The program is the answer; the
   * front matter says when to start it.
   */
  if (/^\s*jobs\s*:/m.test(front))
    return { ok: false, error: 'A workflow written as a program declares its triggers in front matter, not its jobs - the program decides those. Remove the `jobs:` block.' }

  const name = path.split('/').pop() ?? path

  /*
   * Which machine runs the program.
   *
   * Top level in the front matter rather than inside a job, because from the
   * author's side there is no job to put it in - the orchestrator is this
   * layer's invention, not theirs. Lifted out before the block reaches the
   * parser, which would rightly refuse a `runs-on:` that belongs to no job.
   *
   * A program mostly waits on other machines, so the default is the ordinary
   * label rather than anything special: what it needs is a runner that exists.
   */
  const runsOn = front.match(/^runs-on:[ \t]*(.+)$/m)?.[1]?.trim() || 'ubuntu-latest'
  const declarations = front.replace(/^runs-on:[ \t]*.+$/m, '').trimEnd()

  /*
   * Indented into a single job. The orchestrator is an ordinary command job in
   * every way a runner cares about - claimed, leased, running untrusted code on
   * a machine that is not the control plane - which is what lets it go through
   * the claim like anything else.
   */
  const document = [
    declarations,
    '',
    'jobs:',
    '  orchestrate:',
    `    name: ${JSON.stringify(name)}`,
    `    runs-on: ${JSON.stringify(runsOn)}`,
    '    steps:',
    '      - name: Run the workflow program',
    `        uses: ${ORCHESTRATE_ACTION}`,
    '        with:',
    `          workflow: ${JSON.stringify(path)}`,
    '',
  ].join('\n')

  return { ok: true, document }
}

/**
 * The step that runs a program, named as an action rather than a shell command.
 *
 * Intercepted by the runner, the same way `actions/cache` is: what has to
 * happen is "load this file and drive it against the journal", which is not a
 * thing a shell line can express and not a thing that should depend on what is
 * installed on the machine.
 */
export const ORCHESTRATE_ACTION = 'reviewos/orchestrate@v1'

/** Whether a job is the program driving its run. */
export function isOrchestratorJob(jobKey: string, sourcePath: string | null | undefined): boolean {
  return jobKey === 'orchestrate' && isProgramPath(String(sourcePath ?? ''))
}
