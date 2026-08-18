/**
 * Running a step inside a container image.
 *
 * `uses: docker://registry/image:tag` is the third kind of action, and it is
 * the one this runner refused until now. The refusal was honest - executing an
 * image needs a container runtime, and pretending to run one by running its
 * entry point on the host would be the opposite of what an image is for - but a
 * refusal is not an implementation, and every workflow that publishes with
 * somebody else's action hit it.
 *
 * **The argv is built by a pure function**, and that is the point of this file.
 * A container run is a long command line where every mistake is silent: a
 * missing `--rm` leaks containers until a machine fills up, a mount at the
 * wrong path makes an action see an empty workspace, an environment variable
 * carrying a host path points a tool at a directory that does not exist inside.
 * None of those fail loudly, and all of them are testable without a runtime -
 * so the shape is decided here and the execution is three lines elsewhere.
 */

/** Where the workspace is mounted, which is the path Actions has used since 2019. */
export const CONTAINER_WORKSPACE = '/github/workspace'

/** The runtimes this looks for, in the order it prefers them. */
export const CONTAINER_RUNTIMES = ['docker', 'podman'] as const

export interface ContainerRun {
  /** The image, as written in the reference. */
  image: string
  /** The workspace on the host, which is mounted in. */
  workspace: string
  /** The environment the step would have had, with host paths translated. */
  environment: Record<string, string>
  /** `with.entrypoint`, when the step named one. */
  entrypoint?: string | null
  /** `with.args`, as written. Split the way a shell would split it. */
  args?: string | null
}

/**
 * The whole command line, as an argv.
 *
 * An array rather than a string because a string would have to be quoted for a
 * shell, and the values in it - an image name, an argument, an environment
 * value - come off a workflow file that anybody who can push may edit. `docker`
 * is executed directly, so there is no shell to quote for and nothing to
 * escape wrongly.
 */
export function containerCommand(runtime: string, run: ContainerRun): string[] {
  const argv = [
    runtime,
    'run',
    /*
     * Removed when it exits. A runner that leaves containers behind fills the
     * machine over a week of builds, and the failure is somebody else's job
     * failing to start on a host with no disk.
     */
    '--rm',
    /*
     * No extra privileges, ever. An action that needs them is asking for the
     * machine rather than for a container, and a runner that grants it has no
     * isolation left to offer.
     */
    '--security-opt', 'no-new-privileges',
    // The workspace, at the path every action written for Actions expects.
    '--volume', `${run.workspace}:${CONTAINER_WORKSPACE}`,
    '--workdir', CONTAINER_WORKSPACE,
  ]

  for (const [key, value] of Object.entries(translate(run.environment, run.workspace))) {
    // `--env KEY=value` rather than `--env KEY`, which would read the value out
    // of the runner's own environment - a way for a workflow to ask for a
    // variable this process holds and the job was never given.
    argv.push('--env', `${key}=${value}`)
  }

  if (run.entrypoint)
    argv.push('--entrypoint', run.entrypoint)

  argv.push(run.image)

  for (const argument of splitArguments(run.args ?? ''))
    argv.push(argument)

  return argv
}

/**
 * Host paths, as the container will see them.
 *
 * `GITHUB_OUTPUT`, `GITHUB_ENV` and the rest are files under the workspace, and
 * an action inside a container writes to the path it was given. Left untouched,
 * those point at a directory that does not exist inside - so the action writes
 * happily to nothing and its outputs are silently empty, which is the shape of
 * bug that costs an afternoon.
 *
 * Only the workspace prefix is rewritten. A value that happens to contain the
 * path but is not one - a message, a URL - is left alone by requiring the value
 * to start with it.
 */
export function translate(environment: Record<string, string>, workspace: string): Record<string, string> {
  const prefix = workspace.replace(/\/+$/, '')
  const translated: Record<string, string> = {}

  for (const [key, value] of Object.entries(environment)) {
    const text = String(value ?? '')

    translated[key] = text === prefix || text.startsWith(`${prefix}/`)
      ? `${CONTAINER_WORKSPACE}${text.slice(prefix.length)}`
      : text
  }

  // The workspace itself, said plainly: an action reading GITHUB_WORKSPACE gets
  // the path it can actually use.
  translated.GITHUB_WORKSPACE = CONTAINER_WORKSPACE

  return translated
}

/**
 * `args:` split the way a shell would, without a shell.
 *
 * Actions passes `args` through as the container's command, and workflows write
 * them as one string with quotes in it. Splitting on whitespace alone would
 * break every argument containing a space - a commit message, a path - and
 * handing the string to a shell would make every quote in a workflow file a
 * place somebody can inject a command.
 */
export function splitArguments(raw: string): string[] {
  const text = String(raw ?? '').trim()

  if (!text)
    return []

  const parts: string[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  let started = false

  for (const character of text) {
    if (quote) {
      if (character === quote)
        quote = null
      else
        current += character

      continue
    }

    if (character === '"' || character === '\'') {
      quote = character
      started = true
      continue
    }

    if (/\s/.test(character)) {
      if (current || started) {
        parts.push(current)
        current = ''
        started = false
      }

      continue
    }

    current += character
  }

  if (current || started)
    parts.push(current)

  return parts
}

/**
 * Which runtime this machine has, or null.
 *
 * `REVIEWOS_CONTAINER_RUNTIME` wins, because an operator with both installed
 * has a reason for choosing one. Otherwise docker then podman, which is the
 * order of "what is on a build machine" rather than a preference.
 *
 * Null is a first-class answer: a runner with no container runtime is the
 * ordinary case, and the step that needs one is told so by name rather than
 * failing on a command not found.
 */
export async function containerRuntime(look = which): Promise<string | null> {
  const named = String(process.env.REVIEWOS_CONTAINER_RUNTIME ?? '').trim()

  if (named)
    return (await look(named)) ? named : null

  for (const candidate of CONTAINER_RUNTIMES) {
    if (await look(candidate))
      return candidate
  }

  return null
}

/** Whether a binary is on `PATH`. Separated so the lookup can be faked in a test. */
async function which(binary: string): Promise<boolean> {
  try {
    return Boolean(Bun.which(binary))
  }
  catch {
    return false
  }
}
