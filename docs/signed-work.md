# Signed work

Every job this instance hands to a runner carries a signature over the work
itself. A pool can be set to refuse anything unsigned.

The problem it removes is one sentence: **anyone who can write to the control
plane's database can execute arbitrary code on every runner in the fleet.** A
row in `workflow_version_steps` is a command a machine runs, as whoever started
the runner, on a host that usually has more access than the workflow that
earned it. Nothing in the claim protocol distinguishes a step a workflow author
wrote from one somebody inserted.

## What is signed

The canonical encoding of:

- the run and job the work belongs to,
- the matrix combination, which changes what the steps mean,
- and for every step: the command, the `uses:` reference, the environment, and
  the working directory.

The environment is in that list deliberately. Signing the command alone leaves
the same hole one indirection along - `NODE_OPTIONS`, `LD_PRELOAD`, a `PATH`
with somebody's directory first - and a signature that covers what runs but not
what it runs with is a signature with a way past it.

Canonical means keys sorted and no whitespace, on both sides. A signature over
"whatever `JSON.stringify` produced this time" fails when a key order changes
and passes when it should not.

## Why the database is not enough to forge one

The private key lives in `instance_keys` encrypted with `APP_KEY`, which is in
the environment. So the writer this protects against - somebody with the
database and not the process - can change a step but cannot sign it, and a
runner that verifies will not run it.

The key is generated on first use with `purpose: 'steps'`, and rotates the way
the identity keys do: a new key signs from that moment, retired keys keep
verifying, every signature names its `kid`.

## A key set of its own

The public halves are at:

```
/.well-known/reviewos-step-keys.json
```

Not in `jwks.json`. Those two documents say different things: the identity keys
vouch for *who a job is* to a cloud provider, and these vouch for *what a runner
should execute* to a machine inside the fleet. One set holding both invites a
verifier to accept either statement in place of the other - and it would be a
strange thing to hand a cloud that only asked who a job is.

Both documents are public and uncredentialed, because their content is public
keys. An operator can check a job's signature from a shell.

## Turning it on

Off by default. A fleet that started refusing every job the day it upgraded is
a fleet nobody upgrades.

```bash
curl -X POST https://your-instance/api/instance/fleet \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"operation":"require-signatures","pool":3,"required":true}'
```

Per pool rather than per instance, because the machines that need it are the
ones with something worth stealing on them - a deploy pool holding cloud
access - and a laptop running `runner:local` is not that.

The flag travels to the machine with the claim rather than being configured on
the machine, so turning it on covers every runner in the pool rather than the
ones whose config file somebody remembered to edit.

## What the runner does

Before the workspace exists and before the first hook, because the point is
that unverified work never reaches a shell, and a check made after
`pre-bootstrap` has run is a check that already executed something.

It **fetches** the key set rather than reading a key out of the claim. A
signature checked with a key carried in the same message proves only that
whoever wrote the message can do arithmetic.

A refusal reports the job as failed with the reason, rather than dropping it:
a run that never reaches a terminal state holds a pull request's checks open
forever.

Keys that cannot be fetched are also a refusal. The pool asked for signed work,
"I could not check" is not "it was fine", and the failure mode of the other
reading is a network somebody can arrange.

## The honest limits

- **A runner older than this feature ignores the requirement.** The flag is a
  field in the claim payload; a machine that does not read it keeps working.
  Turning the switch on protects the runners that have been upgraded and no
  others. The API answer says so rather than leaving an operator to find out.
- **An instance that cannot read its own key hands out unsigned work.** A
  rotated `APP_KEY` or an unreachable database yields no signature rather than
  no work, and pools that require signatures then refuse everything - loudly,
  at the runner, with a reason. The alternative was failing every claim on the
  instance over a feature most of them do not enforce.
- **This is not a supply chain signature.** It says this instance dispatched
  this work. It says nothing about whether the workflow file was reviewed, or
  whether the action a step pulls in is what its author published.
