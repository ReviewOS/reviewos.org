# Insight

The numbers an operator opens on a Monday: how often pipelines pass, how long
they take, how long they wait for a machine, what the machines cost, and what
the flaky tests are costing in re-runs.

Every figure here is available two ways, computed once so they cannot disagree:

- **A screen**, at `/{owner}/{repository}/insight`, for one repository.
- **The API**, at `GET /api/insight`, in the same shape the screen renders.

## The window

Everything is measured over a window you choose, defaulting to seven days and
capped at ninety. A window outside that range is clamped rather than refused,
and the response says which window it actually used:

```json
{ "window": { "days": 7, "from": "2026-08-10T09:00:00.000Z", "to": "2026-08-17T09:00:00.000Z" } }
```

## What is reported

### Runs

Run count, success rate, median and 95th-percentile duration, and the share of
jobs that took more than one attempt - overall and per workflow.

```bash
curl "https://example.com/api/insight?owner=acme&repo=api&days=30" \
  -H 'Authorization: Bearer ros_...'
```

```json
{
  "overall": { "runs": 214, "success_rate": 0.873, "p50_ms": 264000, "p95_ms": 741000, "retry_rate": 0.031, "samples": 209 },
  "workflows": [
    { "workflow": "CI", "path": ".github/workflows/ci.yml", "runs": 180, "success_rate": 0.9, "p50_ms": 240000, "p95_ms": 690000, "retry_rate": 0.02, "samples": 178 }
  ]
}
```

Two things about these numbers are deliberate.

**A rate with too little behind it is `null`, not a number.** Under five
finished runs there is no success rate and no percentile, and the response says
`null` with `samples` beside it. A success rate over three runs is the last
three runs; printing it as a percentage is how a figure nobody should trust ends
up in a planning document. The screen renders those as a dash.

**Cancelled runs are not failures.** A run somebody stopped on purpose - a
superseded push, a queue being drained - is left out of the success rate
entirely. Counting it as a failure makes the teams who cancel superseded runs,
which is the behaviour you want, look like the least reliable teams you have.

Percentiles are nearest-rank rather than interpolated, so a reported p95 is a
duration some run actually took.

### Failure by job

Which job the red builds are in, ranked by how many builds went red rather than
by failure rate. A job that fails a tenth of four hundred runs costs forty red
builds; a job that failed its only run has a rate of 1.0 and costs one.

### Queue wait

Median and p95 wait by queue and by pool. **This is the number that says to add
runners.**

It is measured from the moment a runner could have taken the job to the moment
one did, which is not the same as the moment the run was created. A job waiting
on `needs:` has not been waiting for a machine, and measuring from run creation
reports your dependency graph as a fleet shortage. Jobs still waiting are not
included at all: a percentile that climbs while nothing happens describes the
dashboard's clock rather than the queue.

It is per queue on purpose. One saturated queue and three idle ones average out
to a fleet that looks fine while one team cannot ship.

### Runner utilization

Busy time, idle time, and the share of the window each machine spent working.
**This is the number that says to remove some**, and it is meant to be read
next to the wait above: a long wait beside an idle fleet is a routing problem
and a long wait beside a busy one is a shopping list. Only the two together
tell you which.

### Cost proxies

Total run minutes by repository, by owner, and by queue.

Nothing here is billed. That is exactly why the figure is worth showing:
somebody self-hosting pays for these machines out of a budget nothing else
itemises, and "where did the minutes go" has no other answer.

### Flaky test impact

How many failed runs failed on a test that was **already known** to be flaky,
and what share of your failures that is.

"Already known" is the load-bearing part. A test that this very run taught us
was flaky could not have been fixed beforehand, so it is not an argument for
anything; counting it would make the apparent cost of flakiness rise every time
flake detection got better. Only tests marked flaky before the results arrived
are counted, and the unit is the run - one test failing twice in a run is one
run somebody had to re-trigger.

## Who may ask

- **One repository** (`owner` and `repo`): anybody who can read that repository.
  The numbers are about their own CI.
- **The whole instance** (no `owner`/`repo`): an instance administrator only.
  Fleet-wide utilization and per-owner minutes describe every tenant on the
  instance, which is not something one tenant is owed.

A caller who may not read the instance-wide view gets `404`, not `403` - the
same answer as for a repository that does not exist. Whether this instance has
a fleet is not a fact to confirm to a stranger by the shape of a refusal.

## What is not here yet

- Alerting on any of it. These are figures you read, not thresholds that page
  somebody.
- Retention. The numbers are computed from the run and job rows themselves, so
  a window only reaches as far back as those rows do.
