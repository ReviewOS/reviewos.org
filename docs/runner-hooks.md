# Runner hooks

The machine's own extension point: scripts that run around a job, and around
the runner itself. A fleet that has to inject a proxy, warm a cache, wrap every
command in a profiler, or refuse work it should not run cannot say any of that
in a workflow file - the workflow belongs to the repository, and these are the
machine's business.

The names and the order are Buildkite's, deliberately, so a hook set ports.

## Where they live

| Scope | Where | Who wrote it |
|---|---|---|
| Runner | the directory given to `buddy runner:local --hooks <dir>` | an operator, on the machine |
| Repository | `.reviewos/hooks/` in the checkout | anybody who can push |

A hook is a file named after its stage, and it has to be executable. A file
without an execute bit is not a hook: a `README` dropped in a hooks directory
would otherwise be run as a shell script and its failure reported as the job's.

Plugin hooks are Buildkite's third scope. There are no plugins here yet; when
there are, they will slot between the two above.

## The order

```
pre-bootstrap → environment → pre-checkout → checkout → post-checkout
              → pre-command → command → post-command
              → pre-artifact → post-artifact → pre-exit
```

`runner-startup` and `runner-shutdown` sit outside all of it, either side of the
poll loop, and belong to the machine rather than to any job.

## Precedence

For most stages both scopes run, the machine's first - the second reads what the
first exported.

**Three stages are runner-only**, and this is the security rule rather than a
convention:

- **`pre-bootstrap`** runs before any repository code is fetched. It is the only
  moment a machine can decide whether to run this repository's code without
  having already read it, so a repository hook there would be the code deciding
  whether to trust itself. **A non-zero exit refuses the job**, and the run says
  so.
- **`checkout`** and **`command`** *replace* the built-in behaviour rather than
  adding to it. A repository that could replace the command would not be running
  its own steps any more, and a fleet's profiler wrapper would be quietly
  removed by the first repository that did not want it.

A fork's pull request gets no repository hooks at all. This runner refuses
untrusted runs outright, so that is a second line rather than the only one - and
it is there so the day the first is relaxed for a sandboxed runner, this is not
relaxed with it.

## What a hook gets

Every job hook runs in the workspace, with the job's environment - the same
`GITHUB_*` and `REVIEWOS_*` variables a step sees - plus:

| Variable | Means |
|---|---|
| `REVIEWOS_HOOK` | Which stage this is |
| `REVIEWOS_HOOK_SCOPE` | `runner` or `repository` |
| `REVIEWOS_ENV` | A file to append `NAME=value` lines to |

Anything written to `$REVIEWOS_ENV` is carried into the hooks that follow and
into the steps, the same channel `GITHUB_ENV` gives a step. It is how
`environment` earns its name:

```sh
#!/bin/sh
# hooks/environment - the fleet's package mirror, on every job
echo "NPM_CONFIG_REGISTRY=https://mirror.internal/npm" >> "$REVIEWOS_ENV"
```

A step that sets the same name afterwards wins: the repository's own file is
more specific than the machine's default.

`runner-startup` and `runner-shutdown` get no job and no workspace, because
there is neither. They run in the runner's working directory.

## Failure

**A job hook that fails fails the job.** That is the point: a fleet that must
inject a proxy or refuse untrusted work is one where the hook not working means
the job must not run either, and continuing past a failed hook would make the
guarantee "usually". The reason names the stage and the scope, because "a hook
failed" sends an operator to read the repository's hooks when the failure was
the machine's own.

`post-command`, `post-artifact` and `pre-exit` run whatever happened, so a
teardown still runs after a failed build - and a `pre-exit` that cannot put back
what it set up fails the job even though the steps passed.

A **fleet** hook that fails changes nothing but the log. There is no job to fail,
and a machine that refuses to take work because a warmup script exited 1 is a
machine an operator has to notice before anything happens at all.

## Examples

```sh
#!/bin/sh
# hooks/pre-bootstrap - this machine only builds our own repositories
case "$GITHUB_REPOSITORY" in
  acme/*) exit 0 ;;
  *) echo "this fleet does not build $GITHUB_REPOSITORY"; exit 1 ;;
esac
```

```sh
#!/bin/sh
# hooks/command - every command, inside the sandbox
exec sandbox-exec -f /etc/reviewos.sb sh -c 'bun run ci'
```

```sh
#!/bin/sh
# hooks/pre-exit - put the cache back whatever happened
rsync -a "$GITHUB_WORKSPACE/.cache/" /var/cache/reviewos/ || true
```
