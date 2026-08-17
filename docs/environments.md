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
       "name":"production","wait_minutes":10,"branches":"main,release/*"}'

curl -sX POST https://reviewos.example/api/repos/environments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"add-reviewer",
       "name":"production","reviewer":"dana"}'
```

**That separation is the feature.** A rule a workflow author can edit is a rule
they can remove on the afternoon they are in a hurry, so writing one takes
`repository:settings` while naming an environment in a workflow takes only
push access.

## The three rules

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

## What is not built yet

- **Deployment records** - what went where, when, and the URL it landed on.
  `environment:` accepts Actions' `{ name, url }` form and keeps the name; the
  url is read and discarded.
- **Preview environments** with expiry and a link on the pull request.
