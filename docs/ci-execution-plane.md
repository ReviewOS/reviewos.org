# The execution plane

[The threat model](./ci-threat-model.md) picked the boundary and [the security
review](./ci-security-review.md) recorded, in as many words, that there is no sandbox. This is the
design for the one it named: **a microVM per job, on KVM, opt-in, on hardware an operator provides.**

It is written before the launcher exists, and that ordering is deliberate. It is the same ordering
`app/Actions/Workflow/repairPolicy.ts` used against the repair agent, for the same reason: guardrails
bolted on after the thing they guard are guardrails somebody has already worked around. A network
policy written after the first VM boots is a network policy written against whatever that VM already
does.

## What this answers

Four boxes in [phase 9](./todo/09-checks-ci.md), and two adversarial gates that are blocked on them:

| Box | Answered by |
|---|---|
| Ephemeral workspace, immutable base image, read-only checkout, no host socket, no repository storage mounted | The machine spec: a fresh overlay per job over a read-only rootfs, and a device list with nothing else on it |
| Network policy with a safe default and explicit egress controls | `networkPolicy.ts`, default-deny, with the instance-local ranges unreachable by construction |
| CPU, memory, process, disk, output and wall-time limits **enforced outside the job** | The machine spec again: a VM is given its vcpus and its memory, and cannot ask for more |
| Runner images and toolchains pinned and attestable; a run records exactly what executed it | `vmImage.ts`: an image is named by digest, and the digest is recorded on the run |

The last one is the one that changes the others' meaning. Every limit above is enforced by the
hypervisor rather than by the guest asking nicely, which is what "outside the job" means and what
`ulimit` never was.

## The boundary

**KVM, and nothing softer.** The threat model's table already refuses the alternatives, and it is
worth restating why rather than relying on the reader having the other page open:

- **A container is not a boundary against a determined attacker.** It is a boundary against accident
  and low-effort abuse, and the product category's most common lie is describing it as more.
- **gVisor and Kata** are better and are still a shared kernel or a shared hypervisor story with more
  moving parts than this product can maintain honestly.
- **A microVM** has its own kernel. The escape is a hypervisor bug rather than a kernel bug, and the
  annual `io_uring`/`nf_tables`/cgroups class of bug stops being instance compromise.

**And it is opt-in, on the operator's hardware, for a reason this design cannot change.** The
documented default deployment is one host. On one host, a VM shares a machine with the process
holding every private repository on the instance - so even here, the guidance is that a public
instance runs its execution plane on machines that hold nothing else.

## Shape

A job already travels: control plane → claim → runner. The VM goes *inside the runner*, and the
runner stops being the thing that executes and becomes the thing that supervises.

```
control plane        runner host (operator's)              microVM (per job)
─────────────        ────────────────────────              ─────────────────
claim ───────────▶   spec = machineSpec(job, image)
                     policy = egressPlan(job, config)
                     boot ─────────────────────────────▶   read-only rootfs (by digest)
                                                           + per-job writable overlay
                     supervise  ◀── vsock ──────────────▶  guest agent runs steps
                     tap device, filtered per policy
report   ◀───────    teardown: overlay destroyed,
                     tap removed, VM killed
```

Four properties fall out of that picture, and each is a thing the current executor cannot claim:

**The rootfs is read-only and named by digest.** A job cannot modify the image the next job boots.
The writable layer is an overlay created for this job and destroyed with it, which is what makes the
workspace ephemeral by construction rather than by a `rm -rf` somebody has to remember.

**The host filesystem is not mounted.** Not the repository storage, not a docker socket, not the
runner's own directory. The guest receives the source over vsock, as bytes, the same way it receives
its steps. There is nothing to escape *to* through the filesystem, which removes the entire class of
mount-escape bug rather than guarding against it.

**The limits are the machine's.** `vcpus` and `mem_size_mib` are what the VM has. A guest that spawns
ten thousand processes exhausts its own memory and is killed with the VM; it does not touch the host.
Disk is the overlay's size. Wall time is the supervisor's, and it holds because killing a VM is not a
signal a process can catch or ignore.

**The network is a tap device the host controls.** The guest cannot reconfigure what the host filters,
which is the difference between an egress policy and a request that the guest not do something.

## The network policy

The section that decides whether any of the rest matters. A sandbox with unrestricted access to
instance-local services is not isolated - a job that can reach the control plane's database has
escaped without needing to escape.

**Default deny, with an allowlist.** The safe default is the one an operator gets by doing nothing,
so the default is that a job reaches nothing. That is genuinely usable for a great many workflows and
genuinely unusable for the ones that install dependencies, which is why the allowlist exists and why
the documentation must not pretend the default is free.

**Some destinations are never allowlistable**, and that is the part worth encoding rather than
documenting. An operator writing an allowlist is thinking about registries, not about the fact that
`169.254.169.254` hands out the machine's cloud credentials. So:

- **link-local** (`169.254.0.0/16`), which is the cloud metadata endpoint on every major provider,
- **loopback** (`127.0.0.0/8`, `::1`), which is every service on the runner host itself,
- **the instance's own addresses**, control plane, database and object storage, however they are
  reached,
- **private ranges** (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) by default, because the operator's
  own network is behind them.

A rule naming any of those is refused when the policy is built, rather than dropped quietly. An
allowlist that silently discards the entry somebody wrote is an allowlist that lies about what it
permits.

**Names are resolved by the host, not the guest.** An allowlist of hostnames enforced by IP has a
rebinding hole in it: the guest resolves `registry.example` itself, gets an answer of its own
choosing, and connects wherever it likes. So the guest gets a resolver the host runs, which answers
only for allowlisted names and returns only addresses the policy would permit.

## What this does not protect

Required by the gate, and the section to read first.

- **It is not protection against a hypervisor escape.** It moves the escape from a kernel bug to a
  hypervisor bug. Firecracker's surface is small and it is not zero, and an operator running a public
  instance on shared hardware is still one CVE away from the host.
- **It does not protect the operator's network** beyond the policy they wrote. Default-deny helps;
  an operator who allowlists a wide range has allowlisted a wide range.
- **It does not make a runner trustworthy.** The runner supervises the VM and is itself an
  operator's machine that the control plane treats as compromised-by-design. Nothing here changes
  what a runner may ask the instance for.
- **It does not protect against a malicious image.** Pinning by digest means the image is *the one
  the operator chose*; it says nothing about whether that choice was good. Attestation records what
  executed, which is a different and weaker claim than proving it was safe.
- **It does nothing on a host without KVM**, which includes every macOS machine. The mode is
  unavailable there rather than degraded, because a boundary that silently becomes a container is
  the failure this whole document exists to avoid.

## Phasing

**Phase A - the decision layer.** Everything that can be decided without a hypervisor, written pure
and tested: the machine spec, the egress policy, the image manifest and the attestation record. This
is the `container.ts` pattern, whose own comment makes the argument better than this one could - a
long command line where every mistake is silent, so the shape is decided in a pure function and the
execution is three lines elsewhere.

**Phase B - the launcher.** Boot, the guest agent, the vsock protocol, the rootfs build pipeline, tap
and filter setup, teardown, and integration tests that run a real workload. **This requires a Linux
host with KVM and cannot be written blind.** Every line of it is a security boundary whose correctness
is not visible in the source - a tap device attached to the wrong bridge looks exactly like one
attached to the right bridge - so it must be written where it can be run, and the tests that matter
are the ones that try to reach the metadata endpoint from inside a booted guest and fail.

**Phase C - the review.** [The security review](./ci-security-review.md) gate, by somebody who did not
write the code, before a public runner executes one command. Phase B's absence is not what is blocking
that; the review of the control plane is available now and the execution plane joins it when it
exists.

## What has been verified, and on what

Phase A was written on a macOS arm64 machine with no KVM, and then verified on one that has it: an
Ubuntu 24.04 aarch64 guest with nested virtualization (Apple M3 Pro, `vz`, `/dev/kvm` present),
running Firecracker v1.16.1 with a 6.1.128 guest kernel.

**Verified by running it:**

- The spec `machineSpec` produces **boots a real microVM**. The read-only base image mounts read-only
  inside the guest and the writable overlay is attached beside it - the two-drive design, working.
- The ruleset `nftRuleset` produces **filters real packets**, with controls in both directions. With
  the policy flushed, a guest reached a fake metadata endpoint at `169.254.169.254` and read its
  payload; with the policy applied, it could not. With the policy flushed it reached a service on the
  supervising host; with the policy applied it could not. An allowlisted registry stayed reachable
  throughout, which is the control that says the policy is a policy rather than a blanket deny.

**Two defects were found this way, and neither would have failed a unit test:**

1. **`bootArgs` omitted `init=`.** A machine built from it booted the right kernel and mounted the
   right read-only root, then ran the image's default init instead of the agent. Nothing errored.
   Every marker the test looked for was simply absent. It also carried `noapic` and two `i8042`
   options - x86 settings on an aarch64 machine - and repeated `root=`, `ro` and `pci=off`, which
   Firecracker appends itself from the drive list.
2. **The ruleset had no `input` chain.** A packet addressed to the runner *itself* is seen by
   nftables' `input` hook and never reaches `forward`, so a forward-only ruleset left every service on
   the supervising host reachable from the guest - which is exactly what "loopback is every service
   running on the runner host" means. That chain cannot take a `drop` policy, since it also carries
   the runner's SSH and its link to the control plane, so the guest is denied by the interface it
   arrives on instead.

Both are the failure this document predicted in its first paragraph: not a boot that fails, a machine
that works and is wrong.

## The supervisor

`microvmSupervisor.ts` is the piece that makes a job actually boot into one of these, and
`microvmProtocol.ts` is how the host and guest talk. Both are verified against real Firecracker on
the host above: **a three-step job ran inside a machine, each step's output came back separately, and
the machine and everything it needed were gone afterwards.**

The channel is the serial console rather than vsock. Vsock is the better wire and is more to build -
a device, a guest client, a host listener, and a framing protocol anyway - and the framing is the part
that carries the security, so it would have to be written either way. The console already exists and
already carries the job's output.

**A step can print whatever the agent prints**, which on a shared channel means a step could announce
its own success. Two things close it. The agent declares a byte *length* and the host reads exactly
that many without scanning them, so content cannot terminate a frame it never gets parsed for. And
the header carries a nonce the host generated, delivered on the payload disk and unlinked by the agent
before the first step runs - so there is nowhere left for a step to read it from. Verified by running
a step that prints a well-formed frame: it came back as that step's output, and no phantom step
appeared in the results.

Teardown is a list built as resources are made and released in reverse, unconditionally. A supervisor
that cleaned up only on the happy path would leak a tap device, a filter table and a disk on every
crash and every timeout, and a runner that has leaked forty tap devices stops being able to start
machines for a reason nobody will connect to a build that failed weeks earlier. Checked after a
normal finish and after a wall-clock kill: no taps, no tables, no disks, no processes.

Also verified: a failing step ends the job and the steps after it do not run, and the wall clock kills
the machine rather than asking it to stop.

And a **fifth defect**, found when the host's disk filled during a run. `mkfs` failed partway and left
a root-owned gigabyte behind, which survived teardown for two compounding reasons: the cleanup was
registered only after a *successful* creation, so a partial disk was never registered at all - and the
file it left could not have been removed by the unprivileged process anyway, because the chown that
hands ownership over is the last line of a script that had already failed. The undo is now armed
before the attempt and goes through the privileged path. Verified by reproducing it: a disk larger
than the host can hold now fails and leaves nothing.

### Four defects the supervisor found, none of which a unit test would have

1. **The payload disk was root-owned and Firecracker runs unprivileged.** Making the disk needs root -
   a loop mount does - and booting deliberately does not. The two never agreed, and the failure came
   after the disk, the tap and the filter had all been created successfully.
2. **The agent tried to `mkdir /work` on a read-only root.** The mount point has to exist in the
   image. This is now an image-build requirement rather than something the agent can fix.
3. **The agent had nowhere to write.** With the root read-only it needs a tmpfs for its own scratch.
4. **The serial console translates `\n` to `\r\n`.** Fatal to length framing rather than untidy: the
   host is told how many bytes to expect and the line discipline inserts more, so every count is wrong
   by the number of newlines. A job whose three steps had all run correctly reported nothing, because
   every header carried a trailing `\r` and stopped being a header. Fixed in the guest, which turns
   the translation off before writing, and tolerated in the host parser as well.

## Wired in

`REVIEWOS_EXECUTION=microvm` is what turns it on, and a runner told nothing behaves exactly as it did
before any of this existed. The branch sits at the top of `runOnce`, ahead of the workspace and the
step loop, because everything below it is machinery for running somebody's code as a process on the
runner - the thing this mode exists to avoid. `microvmRun.ts` turns a claim into a machine.

**It refuses rather than falling back.** A runner asked to isolate that has no kernel, no image or no
image digest fails the job and says which piece is missing. A runner that quietly ran the work on the
host instead would be claiming an isolation it does not have, and the job would look identical to one
that had been isolated.

The digest is required for a reason that is about honesty rather than booting: a machine boots
perfectly well from an image nobody named, and what it cannot then do is tell the run what executed
it.

**The fork refusal does not apply in this mode.** The host path refuses an untrusted run with "a
fork's pull request needs an isolated runner"; this is that runner. Verified with a job carrying
`trusted: false` - the case the host path will not touch - which ran in a machine and had the
metadata endpoint blocked by a policy built from the runner's own environment.

**Composite actions run; the others are refused by name.** See below.

## The source

The host checks out; the guest is handed a working tree. That ordering is the security property, not
a convenience: the host has the clone credential and a route to the instance, and the guest has
neither and must keep having neither - the egress policy refuses the instance's own addresses, so a
guest could not clone even if somebody handed it a token.

So `microvmRun.ts` checks out into a staging directory and the tree crosses on the payload disk as
bytes. The credential does not cross with it. `checkoutCode` keeps it in an askpass helper written to
the staging directory's *parent* - existing care, for exactly this reason, and copying the staging
directory copies the tree and nothing else. The staging copy is removed whatever happened, because a
runner that kept them would fill its disk with other people's source, which is a disclosure between
jobs as well as an outage.

`checkoutCode` moved from `localExecutor.ts` to `checkout.ts`, beside `checkoutPlan`, with its command
runner injected. Two reasons, and the second was the one that forced it: a depth, sparse paths,
submodules and LFS have to mean the same thing in both modes or the two drift within a month - and
importing the host executor pulled its entire world into a path whose whole point is that none of it
applies.

## Secrets

`microvmSecrets.ts`. On the host path a job's secrets live in a process environment and nowhere else;
crossing a machine boundary is what makes this a question, because every obvious route writes them
down.

**The payload disk was refused** for a reason this codebase demonstrated rather than theorised: it is
a file on the runner's real filesystem whose deletion is best-effort, and a run whose `mkfs` failed
left a gigabyte of one behind. Putting secrets there turns a memory-only credential into an at-rest
one, on exactly the object already observed surviving a bad afternoon. **The kernel command line is
worse** - world-readable at `/proc/cmdline`, and written into a JSON file on the host on the way
there. **A tmpfs-backed second disk** is better than both and still leaves a block device the guest
can re-read for the machine's whole life.

So they cross on the console, in the other direction, once, before the first step - in RAM on both
sides and on no filesystem on either. Verified: the value reaches the step's environment, and is
absent from the payload disk and from `/proc/cmdline`.

**The guest asks and the host answers**, because bytes written to a serial console before the guest
opens the device are dropped. A probe sent `HELLO-FROM-HOST-STDIN` at boot and the guest received
`LLO-FROM-HOST-STDIN`; a whole frame sent that early is lost, and a reader waiting for its newline
waits for ever.

**Masking is the host's job and it is stronger here than on the host path**, because the console is
the only channel out - every byte of a job's output passes through one redaction. Verified with a
step that printed its secret, and with one that printed it across two writes.

### Three defects, each of which failed silently

1. **The declared length excluded its own trailing newline.** `read` returns false at end of input
   even when it read a partial line, so the guest's loop skipped the last record - which, for one
   secret, is all of them. The header arrived, the bytes arrived, and nothing was exported.
2. **The agent wrote its parsed values to `/tmp/.env.$$` from inside a pipeline subshell** and read
   that path back from the main shell, where `$$` is not reliably the same number.
3. **The masker redacted only the portion it was releasing.** A value that *starts* in the released
   part and finishes in the held tail is not a match yet, so its head went out in the clear and the
   retained half never matched either - the secret was emitted, in two pieces, having passed through
   a masker. The unit test missed it because a short stream never reaches the release path at all:
   everything sits in the buffer until `flush()`, which redacts it. The fix is to redact the whole
   buffer before releasing any of it, and the test now feeds enough output to force releases.

## Actions

`microvmActions.ts`. A `uses:` step is a program the runner fetches, reads a manifest for, maps inputs
into and executes, and none of that machinery exists in a guest that is a shell and a payload disk.
The choice was to build it there or to finish the work on the host.

**The host finishes it.** It resolves the reference, applies the policy, fetches what needs fetching,
reads the manifest, and expands a composite action into the commands it is made of. The guest runs
commands, as before. That is where the work belongs rather than a shortcut around it: resolving an
action needs the network, the cache and the policy, all of which are the host's - a guest that could
fetch its own actions would be a guest with a route out and a say in what it runs.

Verified on real KVM: a composite action with an input, its `GITHUB_ACTION_PATH`, and a **nested**
action whose steps ran in order between its parent's.

**JavaScript and Docker actions are refused by name.** A JavaScript action needs a Node in an image an
operator built, so assuming one would fail at the first step with a message about `node` rather than
about the action. A Docker action needs a container runtime inside a guest whose whole point is being
the isolation boundary. Naming them sends somebody to the right page; skipping them would report
success for work nobody did.

**A local action is addressed in place**, since it arrived with the checkout; only a fetched one is
carried onto the payload disk. The guest path for a local action comes from the *reference*, not from
the host directory - joining an absolute host path to the guest workspace produced a path with the
runner's home in the middle of it, which is how that was found.

### Secrets survive the expansion

The one place this could have undone the secrets design. `with:` values are filled in on the host, so
a workflow writing `${{ secrets.TOKEN }}` in one would have put a credential into a step script - and
step scripts live on the payload disk, which is the at-rest storage that design refused.

So an input holding a secret is not filled in. It becomes a shell *expression* the guest evaluates:
`export INPUT_KEY="$API_TOKEN"`, with the value arriving over the console. Verified by reading the
step script from inside the guest - it contains the reference, the payload disk does not contain the
value, and the step still receives all thirty-three characters of it.

That needed two forms rather than one. Inside a command, `"$TOKEN"` is already a word. In an
assignment it is not: `export K=Bearer "$T"` is two words and the second is lost, so a value mixing
text and secrets becomes one double-quoted string with the references inside it and everything else
escaped for that context.

## The ceilings, exercised

Accepting `vcpu_count` and `mem_size_mib` is not the same as a guest being unable to exceed them, so
each was attacked on real KVM with the host watched throughout.

| Attempt | What happened |
|---|---|
| Read the machine's shape | `nproc` was 2 and `MemTotal` about 485 MB, against 2 vcpus and 512 MiB configured |
| Write 2 GB into a tmpfs, in a 512 MiB machine | The guest died and the job failed; the host's free memory did not move |
| Fork twenty thousand times | The step failed; the host went from 141 processes to 142 |
| Write 4 GB into a 2 GiB overlay | Refused at about 1.9 GB with no space left; the host's disk was untouched |
| Print 50 MB | See below - this one found a defect |

The first four are the roadmap's sentence being true: a guest cannot ask for a seventeenth core, and
one that forks until it dies takes only itself. None of that is `ulimit` asking nicely.

### Output was not bounded, and a serial console makes that fatal

A step printing 50 MB did not produce a large log. It produced a machine still transmitting when the
wall clock killed it - and a job that failed with a timeout saying nothing about the step being
chatty. On a pipe this is a question of log size; on a serial console it is a question of whether the
job finishes at all.

So the agent truncates a step's output to a ceiling and prints a line naming what it dropped, which is
the same trade the host runner's own log ceiling makes. The same test now succeeds, with about a
megabyte of console traffic instead of fifty. The ceiling is `REVIEWOS_MICROVM_MAX_STEP_OUTPUT`,
a megabyte by default - more than any step's useful output and far less than a console can carry in
the time a job has. It travels on the payload disk with the steps rather than over the console with
the credentials, because it is a number an operator set rather than a secret.

A second thing worth knowing: `diskMib` has a floor of 1024, so a smaller request is silently raised.
The payload disk carries the repository as well as whatever the job writes, and a 64 MiB overlay is a
machine that cannot check out.

## What is still not verified

- ~~The source path has not booted.~~ **It has.** A machine booted with a real repository on its
  payload disk: the guest started in `/work/workspace`, saw the checked-out files, read their
  contents, ran a checked-in script whose executable bit had survived the copy, and found `.git`
  present. The clone token was **not** on the payload disk and **not** in `.git` - which is the claim
  this design rests on, checked rather than asserted.
- ~~Secrets are not designed into this.~~ **They are.** See below.
- **No image build pipeline.** What an image must contain - an agent at `/sbin/reviewos-agent`, a
  `/work` mount point - is written here and enforced nowhere.
- ~~Ceilings were accepted, not exercised.~~ **They have been.** See below.
- **aarch64 only**, and **nothing about the hypervisor's own surface** - a microVM moves the escape
  from a kernel bug to a hypervisor bug rather than removing it.
