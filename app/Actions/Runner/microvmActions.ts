/**
 * Running an action inside a machine, by not running one.
 *
 * A `uses:` step is a program the runner fetches, reads a manifest for, maps
 * inputs into, and executes - and none of that machinery exists in the guest,
 * which is a shell and a payload disk. The choice is to build it there or to
 * finish the work on the host and hand the guest something it already knows how
 * to do.
 *
 * This does the second. The host resolves the reference, applies the policy,
 * fetches what needs fetching, reads the manifest, and **expands a composite
 * action into the commands it is made of**. The guest runs commands. Nothing new
 * crosses the boundary except files the action ships.
 *
 * That is not a shortcut around the hard part; it is where the hard part
 * belongs. Resolving an action needs the network, the cache and the policy - all
 * of which are the host's, deliberately, because a guest that could fetch its
 * own actions would be a guest with a route out and a say in what it runs.
 *
 * ## What runs and what is refused
 *
 * **Composite actions run**, including nested ones, which the host executor's
 * own comment says is nearly all of what repositories write: *"repositories' own
 * actions are nearly all composite"*.
 *
 * **JavaScript and Docker actions are refused by name.** A JavaScript action
 * needs a Node in the image, and whether one is there is a property of an image
 * an operator built - so a runner that assumed it would fail at the first step
 * with a message about `node` rather than about the action. A Docker action needs
 * a container runtime inside a guest whose whole point is that it is the
 * isolation boundary. Both refusals name the action, because a step that did
 * nothing and said nothing is the failure people spend an afternoon on.
 *
 * ## Secrets stay symbolic
 *
 * The one place this expansion could undo the secrets design. `with:` values are
 * interpolated on the host, and a workflow may write `${{ secrets.TOKEN }}` in
 * one - so filling it in here would write a credential into a step script on the
 * payload disk, which is exactly the at-rest storage `microvmSecrets.ts` refused.
 *
 * So secret references are left as *shell* references instead: `${{ secrets.FOO }}`
 * becomes `"$FOO"`, and the value is substituted by the guest's own shell from
 * the environment it was given over the console. The secret reaches the step and
 * never touches a disk.
 */

import { inputEnvironment, inputName, missingInputs, parseActionFile } from './actionFile'
import type { ActionDefinition } from './actionFile'

/** One command for the guest, with what it needs around it. */
export interface GuestStep {
  run: string
  /** Applied before the command. Literal values, quoted by the writer. */
  env?: Record<string, string>
  /**
   * The same, for values that must be *expanded by the guest's shell*.
   *
   * Only ever secret references. A literal value is quoted so that whatever is
   * in it stays in it; a secret is deliberately not a literal here, because
   * writing the value would put it on the payload disk. These are emitted as
   * written - already a double-quoted shell string - so `$TOKEN` resolves from
   * the environment the console delivered.
   */
  envExpr?: Record<string, string>
  /** Where it runs, guest-side. Defaults to the workspace. */
  cwd?: string
}

/** A directory the host must copy onto the payload disk. */
export interface ActionShip {
  hostPath: string
  guestPath: string
}

export type Expansion =
  | { ok: true, steps: GuestStep[], ship: ActionShip[], warnings: string[] }
  | { ok: false, reason: string }

/** How the host resolves a reference into a directory it can read. */
export interface ActionResolver {
  (uses: string): Promise<
    | {
      ok: true
      /** Where the host can read it. */
      directory: string
      local: boolean
      label: string
      /**
       * For a local action, where it sits inside the repository.
       *
       * Needed because the guest addresses it relative to its own workspace, and
       * the host directory is an absolute path on a different machine - joining
       * that to the guest workspace produces a path with the runner's home in
       * the middle of it, which is how this was found.
       */
      relative?: string
    }
    | { ok: false, reason: string }
  >
}

/**
 * How deep a composite may nest.
 *
 * The host path has its own limit for the same reason: an action that uses
 * itself is a stack that ends the runner rather than the job, and the honest
 * failure is a message naming the chain.
 */
export const MAX_DEPTH = 10

/**
 * A workflow's steps, as commands the guest can run.
 *
 * Returns a refusal rather than throwing, and refuses the *whole job* rather
 * than skipping a step it cannot expand - a job whose `uses:` quietly did not
 * happen is a job reporting success for work nobody did.
 */
export async function expandSteps(input: {
  steps: readonly any[]
  /** Where the checkout is, guest-side. */
  workspace: string
  /** Where shipped action directories land, guest-side. */
  actionsRoot: string
  resolve: ActionResolver
  /** Carried through nesting; callers pass nothing. */
  depth?: number
  seen?: readonly string[]
  ship?: ActionShip[]
  warnings?: string[]
}): Promise<Expansion> {
  const depth = input.depth ?? 0
  const seen = input.seen ?? []
  const ship = input.ship ?? []
  const warnings = input.warnings ?? []
  const steps: GuestStep[] = []

  if (depth > MAX_DEPTH)
    return { ok: false, reason: `actions nested more than ${MAX_DEPTH} deep: ${[...seen].slice(-3).join(' → ')}` }

  for (const [index, step] of (input.steps ?? []).entries()) {
    const named = String(step?.name ?? step?.uses ?? step?.run ?? `step ${index + 1}`)

    if (step?.uses) {
      const uses = String(step.uses)

      if (seen.includes(uses))
        return { ok: false, reason: `\`${uses}\` uses itself, directly or through ${seen.length} other actions` }

      const resolved = await input.resolve(uses)

      if (!resolved.ok)
        return { ok: false, reason: `${named}: ${resolved.reason}` }

      const manifest = await readManifest(resolved.directory)

      if (!manifest.ok)
        return { ok: false, reason: `${named}: ${manifest.reason}` }

      const refusal = refusalForKind(manifest.definition, uses)

      if (refusal)
        return { ok: false, reason: refusal }

      /*
       * Where the action's own files are, from inside the guest.
       *
       * A local action is already there - it came with the checkout - so it is
       * addressed in place. A fetched one is on the host's cache and has to be
       * carried over, which is the only thing an action adds to the payload
       * disk.
       */
      let guestPath: string

      if (resolved.local) {
        guestPath = `${input.workspace}/${trimRelative(resolved.relative ?? '')}`
      }
      else {
        guestPath = `${input.actionsRoot}/${ship.length}`
        ship.push({ hostPath: resolved.directory, guestPath })
      }

      /*
       * An input's value is filled in on the host - except a secret, which is
       * left for the guest's shell.
       *
       * Splitting them is what keeps the expansion from undoing the secrets
       * design: a literal input is written into the step script, and the script
       * lives on the payload disk. A credential written there is at rest on the
       * runner's real filesystem, which is the exact storage `microvmSecrets.ts`
       * refused.
       */
      const supplied: Record<string, string> = {}
      const suppliedExpr: Record<string, string> = {}

      for (const [name, value] of Object.entries(step.with ?? {})) {
        const written = value === null || value === undefined ? '' : String(value)

        if (SECRET_REFERENCE.test(written)) {
          // The name the action reads, resolved through the same mapping a
          // literal input would take.
          suppliedExpr[inputName(name)] = shellExpression(written)
          supplied[name] = ''
        }
        else {
          supplied[name] = written
        }
      }

      for (const missing of missingInputs(manifest.definition, supplied))
        warnings.push(`\`${missing}\` is a required input of \`${uses}\` and was not given`)

      const environment: Record<string, string> = {
        ...inputEnvironment(manifest.definition, supplied),
        GITHUB_ACTION_PATH: guestPath,
      }

      // Anything given as a secret overrides the empty literal placed above.
      for (const name of Object.keys(suppliedExpr))
        delete environment[name]

      const nested = await expandSteps({
        steps: manifest.definition.steps ?? [],
        workspace: input.workspace,
        actionsRoot: input.actionsRoot,
        resolve: input.resolve,
        depth: depth + 1,
        seen: [...seen, uses],
        ship,
        warnings,
      })

      if (!nested.ok)
        return nested

      for (const inner of nested.steps) {
        steps.push({
          ...inner,
          /*
           * The action's inputs are in scope for what it calls, and a nested
           * step's own `env` wins - which is what makes a wrapper action able to
           * pass its input down and still override it.
           */
          env: { ...environment, ...(inner.env ?? {}) },
          envExpr: { ...suppliedExpr, ...(inner.envExpr ?? {}) },
        })
      }

      continue
    }

    if (!step?.run)
      continue

    steps.push({
      run: symbolicSecrets(String(step.run)),
      env: step.env ? mapValues(step.env, symbolicSecrets) : undefined,
      /*
       * A composite step's working directory defaults to the *workspace*, not to
       * the action's own directory. Actions is explicit about it and it reads as
       * wrong until you write one: an action's steps operate on the repository
       * that called them, and `GITHUB_ACTION_PATH` is how it reaches its own
       * files.
       */
      cwd: step.working_directory ? `${input.workspace}/${trimRelative(String(step.working_directory))}` : undefined,
    })
  }

  return { ok: true, steps, ship, warnings }
}

/**
 * Why this action cannot run in a machine, or null when it can.
 *
 * Named rather than generic, because "this runner does not support that" sends
 * somebody to the wrong page. A JavaScript action is a thing an *image* could
 * support and this one does not; a Docker action is a thing the isolation model
 * refuses.
 */
export function refusalForKind(definition: ActionDefinition, uses: string): string | null {
  if (definition.kind === 'composite')
    return null

  if (definition.kind === 'javascript') {
    return `\`${uses}\` is a JavaScript action, and a microVM runs the image an operator built - which may not contain a Node. Only composite actions run in this mode.`
  }

  if (definition.kind === 'docker') {
    return `\`${uses}\` is a container action, and a microVM is already the isolation boundary - it does not run a container runtime inside itself. Only composite actions run in this mode.`
  }

  return `\`${uses}\` does not say what kind of action it is. Only composite actions run in this mode.`
}

/**
 * A secret reference, left for the guest's shell to resolve.
 *
 * The line that keeps the expansion from undoing `microvmSecrets.ts`. Filling
 * `${{ secrets.TOKEN }}` in here would write the value into a step script on the
 * payload disk - at rest, on the runner's real filesystem, which is the exact
 * thing that design refused. Rewritten as `"$TOKEN"`, the guest's own shell
 * substitutes it from the environment it was handed over the console.
 *
 * Quoted, because an unquoted expansion of a value containing a space is two
 * arguments - and a secret is exactly the kind of value nobody inspects for
 * spaces.
 */
export const SECRET_REFERENCE = /\$\{\{\s*secrets\.[A-Z_][A-Z0-9_]*\s*\}\}/i

/**
 * A value containing secret references, as one double-quoted shell string.
 *
 * `symbolicSecrets` is right *inside a command*, where `"$TOKEN"` is already a
 * word. An environment assignment is not: `export K=Bearer "$T"` is two words
 * and the second is lost. So the whole value becomes one quoted string with the
 * references inside it, and everything else is escaped for that context - a
 * literal dollar or backtick in the surrounding text must not become a second
 * expansion.
 */
export function shellExpression(text: string): string {
  const parts = String(text ?? '').split(/(\$\{\{\s*secrets\.[A-Z_][A-Z0-9_]*\s*\}\})/i)

  const body = parts
    .map((part) => {
      const secret = /^\$\{\{\s*secrets\.([A-Z_][A-Z0-9_]*)\s*\}\}$/i.exec(part)

      return secret ? `$${secret[1]!.toUpperCase()}` : part.replace(/([\\"`$])/g, '\\$1')
    })
    .join('')

  return `"${body}"`
}

export function symbolicSecrets(text: string): string {
  return String(text ?? '').replace(
    /\$\{\{\s*secrets\.([A-Z_][A-Z0-9_]*)\s*\}\}/gi,
    (_, name) => `"$${String(name).toUpperCase()}"`,
  )
}

/** The action manifest in a directory. */
async function readManifest(directory: string): Promise<{ ok: true, definition: ActionDefinition } | { ok: false, reason: string }> {
  for (const candidate of ['action.yml', 'action.yaml']) {
    const file = Bun.file(`${directory}/${candidate}`)

    if (!(await file.exists()))
      continue

    const definition = parseActionFile(await file.text())

    if (definition.error)
      return { ok: false, reason: definition.error }

    return { ok: true, definition }
  }

  return { ok: false, reason: `no \`action.yml\` in \`${directory}\`` }
}

/** A path as it is written in a workflow, without the leading `./`. */
function trimRelative(path: string): string {
  return String(path ?? '').replace(/^\.\//, '').replace(/^\/+/, '')
}

function mapValues(source: Record<string, unknown>, transform: (value: string) => string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [name, value] of Object.entries(source ?? {}))
    out[name] = transform(String(value ?? ''))

  return out
}
