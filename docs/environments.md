# Deployment environments

`environment: production` on a job is the line everybody writes and almost
nobody checks. Parsing the key and running the job anyway is worse than refusing
it: the workflow says the deploy is protected, the run screen shows an
environment, and nothing at all is enforced.

Here the key names *where* a job deploys. What that costs lives on the
repository, not in the file:

```sh
curl -sX POST https://reviewos.example/api/repos/environments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"create",
       "name":"production","wait_minutes":10,"branches":"main,release/*",
       "require_checks":true}'

curl -sX POST https://reviewos.example/api/repos/environments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"add-reviewer",
       "name":"production","reviewer":"dana"}'
```

**That separation is the feature.** A rule a workflow author can edit is a rule
they can remove on the afternoon they are in a hurry, so writing one takes
`repository:settings` while naming an environment in a workflow takes only
push access.

## The four rules

**Required reviewers.** Named people, and **the person who started the run
cannot be the one who approves it** - even when they are on the list. A required
reviewer who can approve their own deploy is a rule that reads as two people and
behaves as one, and it is the failure nobody notices because the list looks
right.

**A wait timer.** Minutes between the job becoming ready and being allowed to
run, so somebody who realises the deploy is wrong has a window to cancel. It
releases itself: a timer that needs a person to end it is a second approval
wearing a clock. The clock runs from when the job was first held, not from the
approval - approving quickly should not extend the window, and not from the
run's start either, since a long build would eat it.

**A branch policy.** `main,release/*` - which refs may deploy here at all. A ref
outside the list is **refused**, not held. Waiting for an approval that must not
be given is worse than a clear no, and a reviewer repeatedly asked to approve
deploys from the wrong branch will eventually approve one.

**Required checks.** `require_checks: true` - the rule people assume already
exists: production does not receive a commit whose tests have not passed. A
check still running **holds** the deploy; one that has already failed **refuses**
it, because waiting for a verdict that has arrived is a job nobody can unstick.

Which checks count is the branch's own list, from its protection rule rather
than from the environment - a deploy held by a stricter reading than the merge
would be a rule nobody could discover. A branch that requires none passes, and
the setting is off by default because an environment is often a preview, and a
preview that waits for the whole suite is one nobody sees until the suite is
green.

It is asked **before** the reviewers are. Asking somebody to approve a deploy and
then telling them the tests failed is how an approval becomes a rubber stamp.

## What a held job looks like

The job sits in `paused` with the reason on it, where somebody looking at a
stuck run is already looking:

```
deploy   paused   production needs an approval from a reviewer.
```

Opening it is the same endpoint that opens a `block:` gate, and it takes
`workflow:approve`:

```sh
curl -sX POST https://reviewos.example/api/repos/workflow-runs/approve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","number":41,"job":"deploy"}'
```

Approving does not always start the job. A wait timer that has not elapsed still
holds it, and the answer says so - claiming it is running when it is not sends
somebody looking for a runner with nothing to do.

## An environment nobody configured

`environment: staging` in a repository with no `staging` runs normally. That is
deliberate: the key is used for documentation in most workflows that have it,
and refusing to run those would break far more than it protects. An environment
protects when it exists and has at least one rule, and `protects: false` comes
back on one that has none.

## Secrets for one environment

A secret attached to an environment reaches **only** a job deploying there, and
only after the gate has opened - see [secrets](./secrets.md). That is the
separation a repository-wide credential cannot express: the deploy token is not
reachable from the test job in the same run, and not reachable from the deploy
job either while it waits for a reviewer.

## A deployment that arrives in stages

A rollout is a plan on the deployment: `10,50,100`, or
`canary:10, half:50, all:100` when the names are worth having on a screen. A
plan that stops short is completed with a final `100` - a rollout that ends at
half and calls itself finished is a deployment half the users never receive.

```sh
curl -sX POST https://reviewos.example/api/repos/deployments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"health",
       "id":412,"health":"healthy"}'
```

Each report moves it: **healthy** promotes to the next stage, **unhealthy**
puts the previous deployment back, and **nothing yet** holds. That third value
is the one that matters - treating "unknown" as failure rolls back every
deployment whose probe is a second slow, and treating it as success promotes on
no evidence at all.

`operation: hold` stops a rollout where it is and `resume` releases it. A hold
beats a healthy check, because somebody watching a graph they do not like is
the reason the button exists. It does *not* keep a failing deployment serving:
a held rollout that has gone unhealthy is not a decision anybody is still
weighing.

An automatic rollback goes through the same path a person's does, so the
history reads identically whether a graph or a human decided - and the restored
deployment names what it put back. Which is the whole difference from one
opaque `deploy --canary` call: afterwards, anybody can say which stage it
reached, what the check returned, and why it went back.
