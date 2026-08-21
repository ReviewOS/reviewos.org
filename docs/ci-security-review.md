# CI security review: the eight surfaces

A prepared audit of the boundary [the CI threat model](./ci-threat-model.md) describes, followed by
the independent implementation review and remediation that phase 9 requires.

The original audit did not discharge that gate: every surface below was code its author wrote or
edited. Its map remains intact so the review is reproducible. The independent review at the end
records what a second reader attacked, the two boundary failures it found, their fixes, the residual
limits and the sign-off outcome.

## How to read it

Eight sections, matching the eight surfaces the roadmap names. Each says:

- **The boundary** - what is being protected from whom, in one sentence.
- **What the code does** - the paths that enforce it.
- **Verified** - the tests that fail if it stops being true. A claim with no test beside it is a
  claim, and is marked as one.
- **Attack this** - what a reviewer should try, phrased as the thing that would be worst if it
  worked.

The threat model's own gate is eight adversarial tests. Those are collected at the end with their
current status, because that list is the actual sign-off and everything above it is context.

## 1. The threat model

**The boundary.** The decision recorded in August 2026: no execution plane by default, a microVM
where a public instance wants fork execution, and container mode documented as *not* a security
boundary.

**What the code does.** The control plane never executes repository code. A workflow program is
translated by reading its front matter **as text**; the program below is bytes on their way to a
machine, never imported or evaluated on this side. `app/Actions/Workflow/program.ts` is the whole of
that boundary and it is small on purpose.

**Verified.** `tests/e2e/workflow-program.test.ts` covers the translation and, since this month, that
a non-deterministic program is refused at sync rather than at replay.

**Attack this.** Anything that turns a workflow document into evaluation on the control plane: an
expression evaluator reachable with attacker-controlled input, a YAML anchor bomb, a `uses:`
reference that resolves to something this instance fetches and runs. The expression engine
(`app/Actions/Workflow/expression.ts`) is the largest attack surface that runs *here* on values that
came from *there*.

## 2. The runner protocol

**The boundary.** A runner is somebody else's machine executing hostile code by design. Nothing it
says may be believed except what its credential proves.

**What the code does.**

- A **job token minted per claim**, hashed in the column. Every runner endpoint resolves the job
  from the token rather than from the request, so "a credential used against the wrong job" is not
  a case to defend against - it cannot be expressed.
- **Optimistic locking on the claim**: `state = 'queued' AND runner_id IS NULL` for free work, and
  `runner_id = <stale holder> AND lease_expires_at = <lapsed value>` for recovery. Two runners
  asking together produce one winner.
- **A signature over the work** (`stepSignature.ts`), RSA, private half sealed with `APP_KEY`. This
  is the one control against a database writer: a row in `workflow_version_steps` is a command a
  machine will run, and a signature the writer cannot mint is what makes that not enough.
- **Version negotiation** before the credential, so a runner that would misread the payload is told
  which end is behind rather than being handed work.
- **At-least-once delivery**, with a duplicate report answering 200. A correct runner retrying must
  not be told 409 forever.

**Verified.** `runner-claim.test.ts` (the race, both directions of lease recovery),
`workflow-signed-steps.test.ts` (a forged step is refused, a rotated key is handled),
`runner-api.test.ts` (token boundaries; a registration token cannot report).

**Attack this.** The signature is verified *on the runner*, against keys the runner fetched from
this instance - so a runner that skips verification is unprotected by design, and `require_signed_steps`
is per pool. Ask what a pool with that flag off actually buys. Then ask what happens if `APP_KEY`
rotates mid-run, and whether an unsigned claim (which `signWork` returns on failure, deliberately,
to avoid taking the fleet down) is distinguishable at the runner from one whose signature was
stripped.

## 3. The sandbox breakout surface

**This is the section that matters. The host executor has no sandbox; the microVM executor does.**

`app/Actions/Runner/localExecutor.ts` runs a job's steps as ordinary processes on the host, in a
workspace directory, as whoever started the runner. That remains correct only for the documented
posture: one team, one box, trusted code. It is not approved by this review for public fork work.

**What exists:** an ephemeral workspace per job, removed afterwards unless a workspace root was
configured; `RUNNER_TEMP` and `RUNNER_TOOL_CACHE` inside that workspace rather than a shared `/tmp`,
so one job cannot read what the last left; a wall-clock timeout the runner enforces and the control
plane backstops; a per-job log ceiling enforced on the way in.

**Since this was written**, archive extraction is guarded: a cache snapshot is inspected before it
is unpacked and refused whole if any entry names a path outside the workspace or links out of it
(`app/Actions/Runner/archiveSafety.ts`). That closes the `../`-and-symlink row in the scorecard
below. It is not isolation and does not belong in the list of things that do not exist - it is one
untrusted input being checked before it is used, on a host that is otherwise exactly as open as the
rest of this section says.

A step's command is also preceded by a bare `ulimit` for address space, file
size, processes and CPU seconds (`app/Actions/Runner/limits.ts`) - no -S or -H, which is how every
shell sets soft and hard at once, so a step cannot raise what it was given. It read `-S -H` until
dash, which is `/bin/sh` on the box, was found to accept that and set nothing at all. Read that as *housekeeping, not a boundary*: it stops the loop that
writes a forty-gigabyte file, and it does nothing whatsoever about an attacker. Two of the four are
off by default because they count something wider than one step - `RLIMIT_NPROC` is per user, and
CPU seconds are not wall time.

**What does not exist on the host path**, and must not be read as existing:

- No memory limit that holds on macOS: `-v` is accepted there and ignored. No disk *quota* - the
  file-size ceiling bounds one file, not a step that writes a million small ones.
- No network policy of any kind. A step can reach the control plane's database if it is reachable
  from that host, its Redis, its repository storage, its loopback interface, and any cloud metadata
  endpoint the machine has.
- No immutable base image, no read-only checkout, no user separation between jobs.
- Nothing verifies what executed a run *on the host path*. `Runner` records a name and labels the
  machine asserted. In microVM mode this is narrowed but not closed: the runner now hashes the image
  and kernel it boots and refuses on a mismatch, and the run records those digests with a
  `provenance` of `measured` - which catches an image rebuilt underneath a runner, and catches
  nothing a dishonest runner does. `attested` needs a root of trust the runner cannot lie through,
  and Firecracker has no vTPM to offer one.

The public-runner boundary is [the execution plane](./ci-execution-plane.md): one KVM microVM per
job, a read-only base image with a per-job writable overlay, no host filesystem or socket mounted,
machine-level CPU, memory and disk ceilings, a supervisor-enforced wall clock, and a host-side
default-deny egress policy. `microvmRun.ts` refuses rather than falling back to the host path when
the kernel, image, digest or Firecracker is missing.

**Verified.** `runner-microvm*.test.ts` covers the machine specification, protocol framing, secret
delivery, source transfer, cleanup and failure paths. `microvm-egress.test.ts` was run on KVM and
proves a booted guest can reach an allowlisted fixture while it cannot reach metadata, the runner
host or a declared instance address. On a host without KVM the suite names what is missing and
skips; it does not substitute a weaker boundary.

**Attack this.** The host path remains open by design, so check that public fork work cannot select
it and that the interface never describes it as isolated. For microVM work, attack the boundary the
runner controls: payload-disk contents, console framing, teardown after partial privileged setup,
DNS rebinding, the nftables input chain, and any accidental host mount or socket. A dishonest runner
can still lie about all of these; attestation remains a separate open roadmap item.

## 4. Secret flow

**The boundary.** A secret must reach the job that needs it and no other job, no fork, and no log.

**What the code does.**

- **Scoped**: instance, pool, owner, repository, environment, narrowest wins. An environment's
  secrets require the gate to have opened, not merely to exist.
- **An untrusted run gets nothing at all**, whatever is set, and is refused an identity token with
  the reason.
- **An owner-defined run** (an organization-wide workflow) gets owner, instance and pool secrets and
  **none scoped to the repository or its environments** - otherwise a repository admin could declare
  a secret with the organization's key name and read what the scan was handed.
- **`only:` narrowing**: a job that names what it needs gets those and no others, so a compromised
  dependency in a test job cannot read a deploy key that job never asked for.
- **Redacted before persistence**, in the control plane as well as on the runner - the runner masking
  its own values is the first line, and the first line is somebody else's program. Job outputs and
  step outputs are redacted on the way in for the same reason: an output is read by whatever comes
  after it.
- **External references resolved at the claim**, with anything undeliverable named rather than
  handed over as an empty string.

**Verified.** `tests/unit/workflow-secrets.test.ts` holds the ladder - a fork gets nothing, an
environment waits for its gate, another environment's never apply, precedence resolves one key set
at three levels. `tests/e2e/ci-security.test.ts` proves delivery works *before* proving it stops, so
a claim carrying no secrets because secrets are broken cannot pass as the feature working.
`tests/e2e/workflow-owner-wide.test.ts` covers the owner-defined inversion.

**Attack this.** The masking is substring-based. Ask what happens to a secret that is one character,
a common word, or base64 of another secret; and whether a job can exfiltrate one through a channel
that is not the log - an artifact name, a step output key, a cache key, an annotation title, a
deployment URL.

## 5. Cache poisoning

**The boundary.** A cache a lower-trust branch wrote must not be restored by a higher-trust one.

**What the code does.** The scope is computed **on the instance** from the run - never sent by the
runner. Restore keys narrow within a scope and cannot reach across one. A fork's writes are
isolated from the branches of the repository it forked.

**Verified.** `tests/e2e/runner-caches.test.ts` has a section of things a runner cannot talk the
instance into, which is the right shape for this surface.

**Attack this.** The entry is a blob the runner uploads and later extracts. The review built real
archives containing path traversal and links outside the workspace and confirmed the entire archive
is refused before extraction. Keep attacking alternate tar dialects, hard links, PAX headers,
newlines in names and listing mismatches: the guard deliberately treats anything it cannot describe
consistently as unsafe.

## 6. Artifact handling

**The boundary.** An artifact is built from a repository's code and often contains it.

**What the code does.** Access is the repository's own permission, with no separate artifact
permission to keep in step. The id is checked against the repository the caller named - without that
it reads out every repository's build output one integer at a time. Every download is an attachment
with `nosniff` whatever the uploader claimed, because an HTML report rendered in place is stored XSS
with extra steps. Expiry is refused before anything sweeps, and the row goes before the blob.

**Verified.** `tests/e2e/runner-artifacts.test.ts`, including that a job of a *different run* gets a
404 and that the test proves the two runs actually differ rather than passing by luck.

**Attack this.** Same archive question as the cache, plus the download path. Artifact names are
cleaned of control characters before storage and quotes and backslashes before
`Content-Disposition`; `artifact-storage.test.ts` pins the control-character rule. The remaining pressure
point is concurrent download volume: individual and set sizes are bounded, but aggregate bandwidth
and connection limits belong to the instance's outer HTTP boundary.

## 7. Fork policy

**The boundary.** A pull request from a fork must not supply its own workflow, and must not gain
anything a stranger should not have.

**What the code does.** The definition comes from `currentVersions` - what the repository has
registered - so there is no path by which a fork's tree becomes a version row. The run records
`head_sha` and `definition_sha` separately, so a reader can see which commit supplied the
instructions. An untrusted run is untrusted for its whole life; approval is per exact commit; a
trigger cannot raise its own trust level.

**Verified.** `tests/e2e/ci-security.test.ts` pins both halves - the definition is the base
branch's, and the run is untrusted - and the claim test beside it pins what the flag buys.

**Attack this.** `pull_request_target` was the exception that broke the rule. It used the trusted
base definition but still checked out the run's head commit, then marked a fork run trusted. That
handed fork code repository secrets and identity-token eligibility. The dispatch now derives trust
only from whether the event came from a fork, for both pull request triggers; approval permits the
run without changing that fact. `ci-security.test.ts` pins the targeted trigger specifically.

## 8. Cancellation behaviour

**The boundary.** A cancelled run must not produce a green check.

**What the code does.** A run goes to `cancelling`, not `cancelled`: the jobs are on machines this
instance does not control. **The lease is revoked at the moment of the request**, not when a runner
acknowledges - that is what stops a worker which already lost its connection publishing a success
over a run somebody stopped. Exactly one report survives a revoked lease: `cancelled`, because the
credential still proves the holder and "I stopped" cannot fabricate a verdict the way "I succeeded"
can. The sweep concludes it after two lease periods, and a job that genuinely succeeded in between
keeps that result rather than having the control plane invent an outcome.

**Verified.** `tests/e2e/workflow-rerun.test.ts` (cooperative cancel, the graph settling behind it),
`runner-reclaim.test.ts` (both directions of recovery: the dead machine's work returns, the live
machine keeps its own).

**Attack this.** The prepared review found that only heartbeat and conclusion checked the lease.
The same token could still upload an artifact, write a cache, append a log, annotate a check or mint
an identity token after cancellation. `authenticateJob` now requires a running job with a live lease
for every runner endpoint. Only the report endpoint may inspect an inactive claim, and its narrower
protocol rule accepts only a duplicate conclusion or a `cancelled` acknowledgement. `runner-api.test.ts`
attacks the five side channels after revocation and an ordinary naturally expired lease.

## The gate, as it stands

The threat model lists eight adversarial tests as the sign-off. Their status today:

| Gate test | Status |
|---|---|
| A fork cannot read a secret, or replace the base branch's workflow | **Met.** `ci-security.test.ts`, both halves. |
| A job cannot reach the database, Redis, repository storage, or loopback | **Met.** `microvm-egress.test.ts` boots a guest and fails to reach the runner host on two ports, refused by the ruleset's `input` chain. |
| A job cannot reach the cloud metadata endpoint | **Met.** Same suite: a booted guest cannot reach a fixture standing at `169.254.169.254` while an allowlisted registry answers in the same run. |
| A lower-trust branch cannot write a cache a protected branch restores | **Met.** `cache-poisoning.test.ts` writes an entry into a fork's real scope and fails to restore it as the default branch, another branch, a second pull request from the same fork, and through the `restore-keys` prefix fallback. |
| An archive with `../` or a symlink does not write outside its destination | **Met.** `archiveSafety.ts` inspects the index and refuses the archive whole before extracting; `runner-archive-safety.test.ts` builds both attacks as real tarballs, including a `../` entry crafted with this repository's own tar writer because the system tar will not create one. |
| A ten-gigabyte log is truncated by policy, not by disk exhaustion | **Met.** Ceiling on the way in, now configurable. |
| A replayed job token, and a step result from a cancelled run, are refused | **Met.** `runner-api.test.ts` now replays the revoked token against logs, artifacts, caches, annotations and identity issuance as well as reporting; `runner-claim.test.ts` covers late step results. |
| A runner that dies mid-job leaves a recoverable run | **Met.** `runner-reclaim.test.ts`, and step results now land on the heartbeat rather than only at the conclusion. |

**Eight met.** The last two were the execution plane's, and there is now an execution plane to put a
policy in: `docs/ci-execution-plane.md`.

They are worth reading with their control in mind. A guest that cannot reach the metadata endpoint
because it has no network at all satisfies the assertion and proves nothing - so the same run
allowlists a registry and requires it to answer. That control is not decoration: it caught the agent
never configuring the guest's network, which had made a green egress test on a machine with no
egress.

The two that moved were closed after this document first scored them. The cache gate had the rules
and no adversarial test, which is a distinction worth keeping - a pure test of `canRestore` passes
just as happily against a `findRestorable` that forgot to call it. The archive gate had neither: the
runner ran `tar -xzpf` and trusted what a previous run had packed, and the guard now refuses the
archive itself rather than relying on which tar is installed.

## What a reviewer should not take my word for

1. That the list above is complete. I chose the eight surfaces from the roadmap line; a reviewer who
   finds a ninth has found the most valuable thing in this document.
2. That "verified" means what I think it means. Each cited test is one I wrote or extended this
   month. Read at least the fork and cancellation ones, because those two carry the most.
3. That the absences in section 3 are the only absences. I know what I did not build; I am a poor
   witness to what I did not think of.

## Independent review and sign-off

Independently reviewed 20 August 2026 against the implementation, not only the scorecard. The review
traced every runner endpoint from its credential to its write, followed both pull request triggers
through dispatch and claim, inspected archive and artifact names at the point they reach a path or
header, and re-ran the adversarial suites named above.

Two blocking findings were found and fixed before sign-off:

1. `pull_request_target` turned a fork event into a trusted run even though the runner checked out
   the fork's head commit. It now remains untrusted, is held under the normal fork approval policy,
   and receives no secret or identity token after approval.
2. Lease revocation was enforced for heartbeat and conclusion but not by the shared job credential.
   A revoked token could still write through other runner endpoints. The shared authenticator now
   requires a running job and live lease everywhere except the reporting path's two narrow delivery
   exceptions.

The focused suites passed across the fork, credential, claim, signed-work, cache, archive, artifact,
cancellation and recovery paths. The KVM egress suite correctly skipped on the
review host because it has no KVM, Firecracker, guest kernel or guest image; its real-guest result
and positive allowlisted-egress control remain recorded in [the execution plane](./ci-execution-plane.md).

**Sign-off outcome: accepted for public fork execution in microVM mode only.** The host executor is
not a sandbox and this review does not approve it for public code. Container mode remains an accident
boundary, not a security boundary. A dishonest runner can still lie, and hardware-backed image
attestation remains the separate open roadmap item; neither limitation is hidden by this sign-off.
