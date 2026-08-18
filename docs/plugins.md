# Plugins

A plugin wraps a job. An action runs as a step. That is the whole decision rule,
and everything below follows from it.

## Which one you want

**Reach for an action** - `uses:` - when the thing you want is a step: check out
code, set up a toolchain, upload a report, post a comment. Actions is the
primary extension mechanism here, the ecosystem is enormous, and nothing on this
page competes with it.

**Reach for a plugin** when what you want is not a step at all:

- it has to happen *before the checkout*, or *after the artifacts*, or when the
  job ends however it ended,
- or it has to happen on **every job in a pool** without being written into each
  of four hundred workflow files, and without a repository being able to remove
  it.

An action cannot do those. It runs where it is written, as the user the job
runs as, after everything before it. A plugin hooks the job's lifecycle.

If you are unsure: write the action. A plugin is the answer to "the workflow
file is the wrong place for this", and if the workflow file is the right place,
it is not the answer.

## Using one

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    reviewos:
      plugins:
        - acme/docker-login#v1.2.0:
            registry: ghcr.io
        - ./.reviewos/plugins/profiler
    steps:
      - run: make release
```

Two sources, both git, both on this instance:

| Reference | Means |
|---|---|
| `owner/name#ref` | A repository here that *is* a plugin, at that tag, branch or commit |
| `./.reviewos/plugins/<name>` | Vendored: a directory in this repository, at this run's own commit |

Fetching from another host is not supported, and that is a decision rather than
a gap. A plugin is code that runs outside the steps; an instance whose jobs
execute whatever a third-party host serves today has no boundary left to
enforce. Vendor it, or push it here.

## Writing one

A plugin is a directory with a manifest and a `hooks/` directory:

```
plugin.yml
hooks/
  environment
  pre-command
  pre-exit
```

```yaml
# plugin.yml
name: docker-login
description: Log in to a registry before the command runs
hooks: [environment, pre-command]
requires: [docker-socket]
parameters:
  registry:
    type: string
    required: true
  retries:
    type: number
    default: 3
  mode:
    type: string
    enum: [oidc, password]
```

The hooks are the stages from [runner hooks](./runner-hooks.md), and a plugin's
hook runs after the machine's own and before the repository's. **Only the stages
the manifest names are read**, so a file appearing in `hooks/` cannot quietly
become a hook.

Parameters arrive as environment, namespaced by plugin:

```sh
#!/bin/sh
# hooks/pre-command
docker login "$REVIEWOS_PLUGIN_DOCKER_LOGIN_REGISTRY"
```

`REVIEWOS_PLUGIN_NAME`, `REVIEWOS_PLUGIN_REFERENCE` and
`REVIEWOS_PLUGIN_COMMIT` are set too, which is what a hook writes into a log
when somebody has to work out later what ran.

### Parameters are checked before the run starts

Against the manifest, at dispatch. A parameter the plugin does not declare, a
number that is a string, a value outside a declared `enum`, or a required one
left out - each fails the job before a machine sees it, with a sentence naming
the parameter.

The unknown-parameter rule is the one worth stating: a misspelled `registery:`
is an error rather than a warning, because a typo silently ignored is a plugin
running with its default while somebody reads the line they wrote and believes
it took effect.

### Testing one locally

```bash
REVIEWOS_PLUGIN_DOCKER_LOGIN_REGISTRY=ghcr.io ./hooks/pre-command
```

That is the whole harness, and it is not a simplification: a hook is a program
that reads environment and exits non-zero to fail the job. To exercise it in a
real run, vendor it at `./.reviewos/plugins/<name>` in a repository and push -
a vendored plugin is resolved from the commit under test, so the edit and the
run are the same change.

## Pinning, allowlists and capabilities

A plugin reference is arbitrary code selection by whoever can edit a workflow
file. Three controls, at three levels - the instance, the owner, and the pool -
and **each level only ever narrows**:

| Control | What it does |
|---|---|
| Allowlist | Only these plugins may run. Empty means every plugin. |
| Pinning | A reference must name a commit or a tag, not a branch. |
| Capabilities | Which of `docker-socket`, `host-network`, `privileged`, `host-mounts` a plugin may ask for. Empty means none. |

The allowlist and the capability list read opposite ways round on purpose. An
empty allowlist that meant *nothing* would turn plugins off for every install
that never opened the screen; an empty capability set that meant *everything*
would hand out a docker socket to a pool nobody configured.

Set them per pool over the API:

```bash
curl -X POST https://your-instance/api/instance/fleet \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"operation":"plugin-policy","pool":3,"allowlist":"acme/docker-login","pinned":true,"capabilities":"docker-socket"}'
```

**Where each check happens matters.** The allowlist and the pinning rule are
answered at dispatch, so the job goes red immediately with the reason. The
capability is answered at the claim, because which pool a job runs in is a fact
about the machine that took it - and a pool that grants a capability could never
receive such a job if dispatch had refused it on the instance's behalf.

A tag counts as pinned, and a plugin is recorded as the commit that tag pointed
at when the run was created - so a tag moved afterwards does not change what a
re-run executes.

## Attaching one to a pool

```bash
curl -X POST https://your-instance/api/instance/fleet \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"operation":"attach-plugin","pool":3,"plugin":"acme/profiler#v2"}'
```

Every job that pool takes runs it, including the ones already queued, and no
repository can remove it. This is the reason plugins exist next to actions.

An attached plugin takes **no parameters**: an operator configured it, and a
value set on a pool would be one nobody reading a workflow could see. A plugin
that declares a required parameter therefore cannot be attached, and the job
says so rather than running it with an empty value.

## The limits, stated

- **A plugin cannot decide whether a repository's code runs, replace the
  checkout, or replace the command.** Those three stages are the machine's
  alone; see [runner hooks](./runner-hooks.md) for why. A plugin that could take
  them over would make the runner scope decorative for any fleet using plugins.
- **A plugin is not sandboxed from the job, or the job from it.** It runs as the
  same user on the same machine. The isolation story is the runner's, and it is
  the one in the [threat model](./ci-threat-model.md).
- **A fork's pull request runs no plugin hooks**, because this runner refuses
  untrusted runs outright and would refuse the hooks with them.
- **There is no plugin registry.** A plugin is a repository, found the way any
  repository is found. A first-party set is not shipped yet.
