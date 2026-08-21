# The CI threat model, and where the boundary is

This is the security decision [phase 9](./todo/09-checks-ci.md) gates its execution plane behind. It
says what ReviewOS will run, what it will not, what the boundary protects, and - the part that
matters most and is usually missing - **what it does not protect**.

Nothing here is a promise about a future sandbox. It is a description of the one decision that
determines every other one in the phase, so that the boxes underneath it can be implemented against
something rather than around it.

## The asset being protected

One sentence, because everything below follows from it:

> A ReviewOS instance is a single Bun process holding the database, the session signing keys, the
> instance secrets, and every bare repository on disk - including the private ones.

A forge is not a CI product that happens to store code. It is the code, and the CI is a feature of
it. That asymmetry decides the whole design: the blast radius of a CI compromise is not "a bad
build", it is every private repository on the instance and every session in it.

## Who the attacker is

Four, in ascending order of how much they are given for free.

1. **A drive-by.** No account. Reaches public repositories and whatever the API exposes
   unauthenticated. Cannot cause a run to exist except through a public fork's pull request, which
   is attacker 2.
2. **A fork contributor.** Opens a pull request from a fork of a public repository. This is the
   central case, and the one every forge has had a CVE about: they can propose *arbitrary code and
   an arbitrary workflow file*, and a naive implementation runs both with the repository's secrets.
   They are not a member, have no permissions, and need none.
3. **A repository member with write access.** Can push to a branch and edit workflow files. Trusted
   with the repository's own secrets by definition - the threat is what they reach *beyond* that
   repository: other repositories on the instance, the control plane, other tenants.
4. **A malicious dependency.** The `postinstall` script, the compromised action, the transitive
   package. Indistinguishable from attacker 3 at runtime and far more likely. Any design that only
   holds when the code is written in good faith does not hold.

Attacker 2 and attacker 4 are the design drivers. Both mean: **assume the code inside a job is
hostile, always, including on the default branch.**

## The decision

**ReviewOS does not execute repository code by default, and its default deployment never will.**

The instance ships a control plane - workflow definitions, triggers, durable run state, logs, the
API - and a runner protocol. Execution happens on machines the operator explicitly provides. This is
Buildkite's split, and it is the correct one for a self-hosted forge for a reason specific to this
product rather than by analogy:

> The documented default deployment is **one host**
> ([phase 11](./todo/11-self-hosting-deploy.md)). On one host, a container shares a kernel with the
> process holding every private repository on the instance. A single kernel privilege escalation -
> the class of bug that gets found in `io_uring`, in `nf_tables`, in cgroups, roughly annually - is
> not a sandbox escape. It is instance compromise.

So the boundary is chosen per deployment, and the instance is honest about which one it has:

| Mode | Boundary | Default | What it is for |
|---|---|---|---|
| **No execution plane** | The instance runs nothing | **Yes** | Every instance, until the operator opts in. External CI reports results through the checks API, which already works. |
| **Self-hosted runners** | Operator's machine, operator's trust | Opt-in | The operator accepts the risk on hardware they chose, on the understanding that a runner is compromised-by-design and must not be able to reach the instance's network or credentials. |
| **microVM** | Hardware virtualization (KVM) | Opt-in, recommended where available | The only mode in which running a public repository's fork pull requests is defensible. |
| **Container** | Namespaces, seccomp, no shared kernel guarantees | Opt-in, discouraged for public instances | Adequate against accident and low-effort abuse. Not adequate against attacker 2 on a public instance. |

**A container is not a security boundary against a determined attacker.** Saying otherwise is the
single most common lie in this product category. It is a resource boundary and an accident boundary,
and this document will not describe it as more than that.

### What follows from the default

The control plane must be *complete and useful* without an execution plane, or the default becomes a
mode nobody runs. That is already the phase's shape: definitions, triggers, durable runs, the API,
logs and the run surface do not require this instance to run anybody's code. A run whose jobs are
dispatched to an operator's runner is a first-class run, not a degraded one.

## The boundary, stated as what it does not protect

Required by the gate, and the section to read first.

- **It does not protect a self-hosted runner from the code it runs.** A runner executes hostile code
  by design. Anything reachable *from* that machine is reachable *by* the job: its network position,
  its cloud instance metadata endpoint, its filesystem, any credential on it. A runner on the same
  network as the instance is a hole through the instance's front door, and the documentation must
  say so where operators will read it rather than here.
- **It does not protect against a compromised runner lying.** A runner reports step results. A
  malicious one can report success for a step it never ran. Branch protection that requires a check
  is therefore only as trustworthy as the runners allowed to satisfy it, which is why a run records
  which runner executed it and why runner registration is an administrative act.
- **A container mode does not protect against kernel escape.** See above.
- **It does not protect secrets from a workflow that is authorized to have them.** Any job given a
  secret can print it, post it, or encode it in an artifact. Redaction stops accidents and
  copy-paste, not exfiltration. The only real control is *not giving the secret*, which is what the
  fork policy below is.
- **It does not protect against a malicious dependency inside an authorized job.** Attacker 4 has
  exactly the privileges of the workflow that installed it.
- **It does not make cache or artifact contents trustworthy.** They are attacker-controlled bytes.
  Restoring a cache is running whatever the last writer put there, which is why the keying and the
  trust rules below exist.
- **It protects a runner from a control plane database somebody else can write to only where a pool
  asks it to.** A row in `workflow_version_steps` is a command every runner would execute, and
  [signed work](./signed-work.md) closes that - the private key is encrypted with `APP_KEY`, so a
  writer with the database and not the process cannot mint a signature. It is off by default and
  enforced per pool, which means an instance that never turned it on has the original exposure.
- **It does not stop a run from consuming what it was given.** Limits bound the damage; they do not
  prevent a job from using its whole quota to be unhelpful.

## The rules the implementation has to satisfy

Each is a constraint on the boxes in phase 9, written so it can be checked rather than admired.

### Fork policy - the one that gets forges breached

0. **A fork's pull request needs a person before it runs at all**, unless the instance says
   otherwise. `fork_run_approval` is `first-time` by default: a contributor whose work has never
   landed here is held, and once it has they are not asked again. Somebody who can push here is not
   asked either, since a push from them would run without asking. The run is `waiting`, which is what
   keeps it away from the claim, and **approving it does not make it trusted** - it runs, and it still
   gets no secrets and no identity token.
1. **The workflow definition comes from the trusted ref, never from the fork.** A pull request from
   a fork runs the workflow as it exists on the base branch. If it ran the fork's version, attacker 2
   writes their own workflow and the rest of this document is decoration.
2. **A fork pull request gets no secrets, no write-scoped token, and no cache write access.** Its run
   is read-only against the instance.
3. **Elevating one is an explicit, per-run, human act** by someone with write access, recorded in the
   audit log with who and which commit - because they are approving a *specific tree*, and a push
   after approval invalidates it.
4. **The default-branch workflow is not automatically trusted with everything either.** Attacker 3
   and attacker 4 live there. Secrets are scoped per environment and job, not per instance.

### Secrets

- Encrypted at rest with the instance key, decrypted only at injection.
- Scoped to an environment and a job, resolved *after* the fork check, never written to the run row,
  the logs, the artifacts, or the step outputs.
- Redacted on the way to persistence, not on the way to the screen, so a stored log never contains
  one.
- Never passed as a command-line argument, which is world-readable in `/proc` on the runner.

### The runner protocol

- A runner authenticates with a registered credential; registration is administrative.
- A job is handed out under a **lease** with an expiry. Results are accepted only from the lease
  holder, and only before it expires, which is what stops a disconnected worker publishing a late
  success over a cancelled run.
- The job token is scoped to the one run, expires with the lease, and cannot read another
  repository. A leaked job token buys the attacker the run they already had.
- The control plane treats every field a runner sends as untrusted input: log bytes, step results,
  artifact names, and durations are all attacker-controlled.

### Caches and artifacts

- A cache key is bound to the declared inputs, the runtime, the architecture and the lockfile
  digest - and **to the trust level of the writer**. A fork or a lower-trust branch may read a cache
  it cannot write, and may never write one a protected branch reads. Without that, cache poisoning is
  a supply-chain attack with a UI.
- Artifacts are content-addressed and checksummed, size-limited, access-controlled by the
  repository's visibility, and expired by policy. They are data, never executed by the control plane.
- Extraction is path-checked: an archive entry may not escape its destination through `..` or a
  symlink. This is the oldest bug in CI and it is still being found.

### Limits, and where they are enforced

Outside the job, always - CPU, memory, processes, disk, output volume and wall time. A limit the job
enforces on itself is a comment. Quotas are per instance, owner, repository, workflow and token, so
one repository cannot starve the instance and one agent cannot starve a person.

### Cancellation

Cooperative first, forceful after a deadline, with the lease revoked at the moment of cancellation
rather than when the runner acknowledges it. A cancelled run must not be able to turn green.

## What has to be true before a public instance runs one command

The gate, restated as tests rather than intentions. Each is an adversarial test in phase 9:

- A fork pull request cannot read a secret, and cannot cause the base branch's workflow to be
  replaced by its own.
- A job cannot reach the control plane's database, its Redis, its repository storage, or its
  loopback interface.
- A job cannot reach the cloud metadata endpoint.
- A lower-trust branch cannot write a cache a protected branch restores.
- An artifact archive containing `../` or a symlink to `/etc/passwd` does not write outside its
  destination.
- A log of ten gigabytes is truncated by policy rather than by disk exhaustion.
- A job token replayed after its lease expires is refused, as is a step result from a cancelled run.
- A runner that dies mid-job leaves a run that is recoverable and not stuck.

## Review status

Written 2026-08-11 and independently reviewed 2026-08-20. The implementation now follows the
decision above: **no execution plane by default, microVM where a public instance wants fork
execution, container mode documented as not a security boundary**. All eight adversarial tests exist;
the review found and fixed a fork-trust bypass through `pull_request_target` and job credentials that
outlived their leases on non-reporting endpoints. The review and residual limits are recorded in
[the CI security review](./ci-security-review.md).

The sign-off is for public fork execution in microVM mode only. It does not turn the host executor or
container mode into a security boundary, and it does not close the separate hardware-attestation
item.
