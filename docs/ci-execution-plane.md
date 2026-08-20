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

## What is still not verified

- **It is not wired into the runner.** `localExecutor.ts` still claims jobs and runs their steps as
  host processes; nothing yet routes a claimed job to `superviseJob`. The supervisor is a component
  with an end-to-end test, not a mode the product can be put into - so the roadmap's boxes stay open.
- **No source reaches the guest.** The steps do; a checkout does not. A real job needs its repository,
  and that is the next thing the payload disk carries.
- **No image build pipeline.** The image used was assembled by hand, and requirements it must satisfy -
  an agent at a known path, a `/work` mount point - are written here rather than enforced anywhere.
- **Secrets have not been designed into this at all.** A job's secrets currently reach a step through
  its environment on the host. What that becomes when the step runs in another machine is an open
  question, and putting them on the payload disk is the obvious answer and probably the wrong one.
- **Ceilings were accepted, not exercised.** Firecracker took `vcpu_count` and `mem_size_mib`; no test
  confirms a guest which forks endlessly dies inside its own memory rather than the host's.
- **aarch64 only.** The x86 path most operators would run is untested.
- **Nothing about the hypervisor's own surface.** A microVM moves the escape from a kernel bug to a
  hypervisor bug; it does not remove it.
