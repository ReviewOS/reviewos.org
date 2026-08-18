/**
 * `action.yml` - what an action declares, and what running it means.
 *
 * Three kinds, and the difference is not cosmetic. A **composite** action is a
 * list of steps, which a runner already knows how to execute: it is the cheapest
 * kind to support properly and the kind most repositories' own actions are. A
 * **JavaScript** action is a file to run with a runtime. A **Docker** action is
 * an image, and needs a container.
 *
 * Read here rather than in the runner's loop so the shapes can be tested
 * without a checkout, and so the runner is left saying what it does rather than
 * what a file means.
 */

export type ActionRunKind = 'composite' | 'javascript' | 'docker' | 'unknown'

export interface ActionInput {
  name: string
  description: string
  required: boolean
  default: string | null
  /** Actions marks an input deprecated with a message rather than a flag. */
  deprecationMessage: string | null
}

export interface ActionStep {
  name: string | null
  id: string | null
  run: string | null
  uses: string | null
  shell: string | null
  workingDirectory: string | null
  env: Record<string, string>
  with: Record<string, string>
  if: string | null
}

export interface ActionDefinition {
  name: string
  description: string
  kind: ActionRunKind
  inputs: ActionInput[]
  /** For a JavaScript action, the entry point and the runtime it asked for. */
  main: string | null
  pre: string | null
  post: string | null
  runtime: string | null
  /** For a Docker action, the image as written. */
  image: string | null
  /**
   * A Docker action's `runs.entrypoint`, when it replaces the image's own.
   *
   * Kept as written, including any `${{ }}` in it: substitution happens where
   * the inputs are known, and doing it here would be a second expression
   * evaluator with a different idea of what is in scope.
   */
  entrypoint: string | null
  /** A Docker action's `runs.args`, joined the way a command line reads. */
  args: string | null
  /** For a composite action, the steps to run in order. */
  steps: ActionStep[]
  /** Why this action cannot be read, when it cannot. */
  error: string | null
}

/**
 * Read an `action.yml`.
 *
 * Never throws: an action file that cannot be read becomes a definition with an
 * error on it, and the runner reports that as a failed step with the reason.
 * Throwing would take down a job for a file the repository controls, which is
 * the wrong direction - the job should fail, not the runner.
 */
export function parseActionFile(source: string): ActionDefinition {
  const empty: ActionDefinition = {
    name: '',
    description: '',
    kind: 'unknown',
    inputs: [],
    main: null,
    pre: null,
    post: null,
    runtime: null,
    image: null,
    entrypoint: null,
    args: null,
    steps: [],
    error: null,
  }

  let root: any

  try {
    // `Bun.YAML.parse`, the same reader the workflow parser uses. A second YAML
    // implementation would mean two files disagreeing about the same document,
    // which is the class of bug nobody finds until a workflow behaves one way
    // and the action it calls behaves another.
    root = Bun.YAML.parse(source)
  }
  catch (error) {
    return { ...empty, error: `this action file is not valid YAML: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (!root || typeof root !== 'object' || Array.isArray(root))
    return { ...empty, error: 'an action file is a mapping with `runs:` in it' }

  const runs = root.runs && typeof root.runs === 'object' ? root.runs : null

  if (!runs)
    return { ...empty, error: 'this action file has no `runs:`, so there is nothing to run' }

  const using = String(runs.using ?? '').toLowerCase()

  const definition: ActionDefinition = {
    ...empty,
    name: typeof root.name === 'string' ? root.name : '',
    description: typeof root.description === 'string' ? root.description : '',
    inputs: inputsFrom(root.inputs),
  }

  if (using === 'composite') {
    return {
      ...definition,
      kind: 'composite',
      steps: stepsFrom(runs.steps),
    }
  }

  /*
   * `node20`, `node16`, `node12`, and whatever comes next.
   *
   * Matched by prefix rather than by a list, because the list changes every
   * year and a runner refusing `node24` for not being in an array it was
   * compiled with is a runner that ages badly. Which runtime actually executes
   * it is the runner's decision, and it says so in the log.
   */
  if (using.startsWith('node')) {
    return {
      ...definition,
      kind: 'javascript',
      runtime: using,
      main: typeof runs.main === 'string' ? runs.main : null,
      pre: typeof runs.pre === 'string' ? runs.pre : null,
      post: typeof runs.post === 'string' ? runs.post : null,
      error: typeof runs.main === 'string' && runs.main.length > 0
        ? null
        : 'this action says it is a JavaScript action but names no `main:`',
    }
  }

  if (using === 'docker') {
    return {
      ...definition,
      kind: 'docker',
      image: typeof runs.image === 'string' ? runs.image : null,
      entrypoint: typeof runs.entrypoint === 'string' ? runs.entrypoint : null,
      /*
       * `args:` is a list in an action file and a command line to the container.
       * Joined with spaces here and split again by the runner, which sounds
       * circular and is not: the runner also has to accept `with.args` from a
       * `docker://` step, which is written as one string, and one path through
       * the splitter means one set of quoting rules rather than two.
       */
      args: Array.isArray(runs.args)
        ? runs.args.map((one: unknown) => (typeof one === 'string' ? quoteIfNeeded(one) : String(one ?? ''))).join(' ')
        : (typeof runs.args === 'string' ? runs.args : null),
    }
  }

  return {
    ...definition,
    error: `\`runs.using: ${using || '(missing)'}\` is not something this runner knows how to execute`,
  }
}

function inputsFrom(value: unknown): ActionInput[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return []

  return Object.entries(value as Record<string, any>).map(([name, body]) => {
    const definition = body && typeof body === 'object' ? body : {}

    return {
      name,
      description: typeof definition.description === 'string' ? definition.description : '',
      required: definition.required === true,
      // Kept as written and stringified: an action's default is handed to a
      // process, and a process receives strings.
      default: definition.default === undefined || definition.default === null
        ? null
        : String(definition.default),
      deprecationMessage: typeof definition.deprecationMessage === 'string' ? definition.deprecationMessage : null,
    }
  })
}

function stepsFrom(value: unknown): ActionStep[] {
  if (!Array.isArray(value))
    return []

  return value.map((entry) => {
    const step = entry && typeof entry === 'object' ? entry as Record<string, any> : {}

    return {
      name: typeof step.name === 'string' ? step.name : null,
      id: typeof step.id === 'string' ? step.id : null,
      run: typeof step.run === 'string' ? step.run : null,
      uses: typeof step.uses === 'string' ? step.uses : null,
      /*
       * A composite step's `shell:` is required by Actions and this does not
       * enforce it. The requirement exists because Actions runs on three
       * operating systems and will not guess; a runner that has already decided
       * it runs `sh` gains nothing by refusing a file for not repeating that.
       */
      shell: typeof step.shell === 'string' ? step.shell : null,
      workingDirectory: typeof step['working-directory'] === 'string' ? step['working-directory'] : null,
      env: stringMap(step.env),
      with: stringMap(step.with),
      if: typeof step.if === 'string' ? step.if : null,
    }
  })
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {}

  const values: Record<string, string> = {}

  for (const [name, entry] of Object.entries(value as Record<string, unknown>))
    values[name] = entry === null || entry === undefined ? '' : String(entry)

  return values
}

/**
 * The environment an action's steps see for their inputs.
 *
 * `with: { who: world }` becomes `INPUT_WHO=world`, which is the contract every
 * action written against Actions reads. The name is upper-cased and spaces
 * become underscores, exactly as the toolkit does it - an action reading
 * `INPUT_MY_NAME` for `my name` is relying on that transformation, and getting
 * it wrong means the input silently arrives empty.
 */
export function inputEnvironment(
  definition: ActionDefinition,
  supplied: Record<string, string>,
): Record<string, string> {
  const environment: Record<string, string> = {}

  // Defaults first, so a supplied value overrides one rather than the other way
  // round.
  for (const input of definition.inputs) {
    if (input.default !== null)
      environment[inputName(input.name)] = input.default
  }

  for (const [name, value] of Object.entries(supplied ?? {}))
    environment[inputName(name)] = String(value ?? '')

  return environment
}

/** `my name` becomes `INPUT_MY_NAME`, the way the toolkit reads it. */
export function inputName(name: string): string {
  return `INPUT_${String(name).replace(/ /g, '_').toUpperCase()}`
}

/**
 * Inputs an action declares as required and the caller did not supply.
 *
 * Reported rather than enforced by refusing: Actions itself only warns, and an
 * action that copes without an input it called required is one that would
 * otherwise stop working here for no reason a person could see.
 */
export function missingInputs(definition: ActionDefinition, supplied: Record<string, string>): string[] {
  return definition.inputs
    .filter(input => input.required && input.default === null)
    .filter(input => !(input.name in (supplied ?? {})))
    .map(input => input.name)
}

/**
 * One argument, quoted only when it would otherwise split.
 *
 * An action file's `args:` is already a list, so the words in it are decided:
 * joining them and splitting again would break an argument containing a space
 * unless the join says where the boundaries were.
 */
function quoteIfNeeded(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}
