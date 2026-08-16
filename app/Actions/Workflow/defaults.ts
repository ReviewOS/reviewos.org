/**
 * `defaults:` - the shell and directory a step runs in when it does not say.
 *
 * Three levels again, narrowest wins, and the same reason for keeping them
 * apart as [`env`](./env.ts): a reader has to be able to check the rule, and a
 * merged value cannot say which level it came from.
 *
 * The difference from `env` is what "nothing" means. An env name defined
 * nowhere is simply absent; a shell defined nowhere is **the runner's choice**,
 * which this side deliberately does not make. Baking `bash` here would be a
 * default invented by the control plane and then impossible to tell apart from
 * a workflow that asked for bash - and the answer differs by platform, which is
 * knowledge the runner has and this does not.
 */

export type DefaultLevel = 'step' | 'job' | 'workflow' | 'runner'

export interface StepDefaults {
  /** Null means the runner decides, which is a real answer rather than a gap. */
  shell: string | null
  workingDirectory: string | null
  /** Where each came from, for a screen that has to explain it. */
  shellFrom: DefaultLevel
  workingDirectoryFrom: DefaultLevel
}

export interface DefaultsInput {
  workflow?: { shell?: string | null, workingDirectory?: string | null } | null
  job?: { shell?: string | null, workingDirectory?: string | null } | null
  step?: { shell?: string | null, workingDirectory?: string | null } | null
}

/**
 * What this step actually runs with.
 *
 * A step's own `shell:` wins, then the job's `defaults.run.shell`, then the
 * workflow's. An empty string is not a value: `shell: ''` in a file is a
 * mistake, and treating it as an answer would hand the runner an empty command
 * name rather than falling through to the level that meant something.
 */
export function resolveDefaults(input: DefaultsInput): StepDefaults {
  const shell = pick([
    ['step', input.step?.shell],
    ['job', input.job?.shell],
    ['workflow', input.workflow?.shell],
  ])

  const workingDirectory = pick([
    ['step', input.step?.workingDirectory],
    ['job', input.job?.workingDirectory],
    ['workflow', input.workflow?.workingDirectory],
  ])

  return {
    shell: shell.value,
    shellFrom: shell.level,
    workingDirectory: workingDirectory.value,
    workingDirectoryFrom: workingDirectory.level,
  }
}

/** The first level that actually said something, or the runner's choice. */
function pick(levels: Array<[DefaultLevel, string | null | undefined]>): { value: string | null, level: DefaultLevel } {
  for (const [level, value] of levels) {
    if (typeof value === 'string' && value.trim().length > 0)
      return { value, level }
  }

  return { value: null, level: 'runner' }
}

/** Read a stored `defaults` pair off a row, whatever the column names carry. */
export function defaultsOf(row: any): { shell: string | null, workingDirectory: string | null } {
  return {
    shell: row?.default_shell ?? null,
    workingDirectory: row?.default_working_directory ?? null,
  }
}
