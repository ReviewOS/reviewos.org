# Test intelligence

What your tests have been doing, over time, across commits and reruns - so a
flaky test is a fact somebody can act on rather than a feeling.

**It works for a repository whose CI is somewhere else.** Results arrive over an
endpoint from wherever they were produced, so you can get flake detection before
you move a single pipeline. A feature that only works after a migration is one
nobody evaluates.

## Reporting results

```sh
curl -sX POST https://reviewos.example/api/repos/tests/ingest \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg r "$(cat junit.xml)" '{
    owner: "acme", repo: "widgets",
    suite: "unit",
    sha: "'"$GITHUB_SHA"'",
    branch: "main",
    key: "'"$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'",
    format: "junit",
    report: $r
  }')"
```

The credential needs `check:report` - the ability a CI integration already has
to say a commit passed. Reporting *which* tests passed is the same act at a
finer grain, and a separate scope would mean every existing integration asking
for one more permission to tell you more.

**`key` is what makes retrying safe.** Every collector retries, and a retry that
fails is a collector that retries again. Same key, same run: the history does
not double, which matters because everything downstream - flake detection most
of all - would otherwise be answering from data that never happened.

### What comes back

```json
{
  "run": 41,
  "duplicate": false,
  "verdict": "passed",
  "counts": { "passed": 812, "failed": 0, "skipped": 4, "muted_failures": 1 },
  "newly_flaky": ["e2e/checkout.spec.ts › checks out"]
}
```

`verdict` **ignores muted failures**, which is the whole of what a mute does
here. A collector that wants a mute to decide the job's outcome uses it as the
exit status:

```sh
[ "$(… | jq -r .verdict)" = passed ] || exit 1
```

Nothing here can reach back and change what your test runner already did - it
exited before these results were sent. The endpoint tells you what this instance
concludes; using it is your choice.

## The two formats

**JUnit XML** because every framework in every language can emit it and most
already do. It is read with a scanner rather than an XML library, deliberately:
the input is a file from a machine this instance does not control, and a reader
that cannot be made to resolve an external entity or allocate a gigabyte is
worth more here than one that handles namespaces. Entities are decoded; nothing
is ever *resolved*.

**JSON** because JUnit cannot carry the things that turn out to matter:

```json
{ "tests": [
  { "scope": "e2e/checkout.spec.ts", "name": "checks out",
    "result": "passed", "duration_ms": 900, "retries": 1,
    "tags": ["browser=firefox", "shard=2"] }
] }
```

`retries` and `tags` are the reason it exists. A failure that only happens on
one browser or one shard is the most useful thing a suite can tell you, and it
is invisible without somewhere to put the dimension.

## How a test is identified

**Suite, scope, and name.** Scope is the file or class the reporter gave, and it
is what makes this work: two tests called `renders` in different files are two
tests, and a tool that keys on the name alone reports one flaky test that is
really two healthy ones.

A rename makes a new test. That is the honest answer rather than a heuristic:
guessing that `renders the header` and `renders a header` are the same test is
guessing about intent, and being wrong loses the history of the test that still
exists - which is the history somebody is about to make a decision from.

## Flaky detection

Two shapes count, over the last twenty executions of a test:

- **Disagreeing about one commit.** It passed and failed on the same code, so
  the code is not what changed.
- **Passing only after a retry.** A test that needed three attempts did not
  pass; it failed twice and then got lucky. A reporter that stores only the
  final verdict has thrown that away before anybody could act on it - which is
  why `retries` is worth sending.

One failure is a failure, not a flake. Calling it flaky there would be telling
somebody to ignore a broken test.

## Muting, skipping, and quarantine

Three states, where most tools have two:

| | Runs? | Reports? | Fails the run? |
|---|---|---|---|
| `enabled` | yes | yes | yes |
| `muted` | yes | yes | **no** |
| `skipped` | no | no | no |

**A muted test still runs and still reports.** Its failures are counted, shown,
and kept in its history; they are simply set aside when this instance reaches a
verdict. That keeps the signal: somebody can see it is still broken, and the day
it starts passing again is visible. A skipped test teaches nobody anything.

```sh
curl -sX POST https://reviewos.example/api/repos/tests/manage \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"mute","test":91,
       "reason":"races with the seed job under load",
       "review":"2026-10-01"}'
```

**A reason and a review date are required.** A mute without a reason is one
nobody can evaluate later; a mute without a review date is one nobody will look
at again, and the suite quietly stops testing what it says it tests. Refusing is
friction on purpose - thirty seconds against a test that would otherwise be off
forever. `operation: "quarantined"` lists them, with `overdue: true` on the ones
whose review date has passed.

`operation: "own"` puts a name on a test, so a failure has an addressee. A flaky
test with nobody's name on it stays flaky.

## Splitting a suite across parallel jobs

`parallelism: 8` everywhere else means "cut the file list into eight
alphabetical pieces and hope". Test files are not uniform - one integration file
is worth forty unit files - so the alphabetical cut gives one node eleven
minutes and another forty seconds, and the job takes eleven minutes.

For a job running here, the runner puts the client on the job's PATH:

```yaml
jobs:
  test:
    strategy:
      matrix:
        node: [0, 1, 2, 3]
    steps:
      - uses: actions/checkout@v4
      - run: |
          find tests -name '*.test.ts'             | reviewos-split unit 4 "${{ matrix.node }}"             | xargs bun test
```

It authenticates with the **job token**, so a sharding job needs no repository
credential of its own - reading timings is something the credential it already
holds can do. From another CI, the same answer comes from
`POST /api/repos/tests/split` with `{ suite, items, nodes, index }` and a
credential with `repository:read`.

### What it guarantees

**Every item lands on exactly one node.** A test that runs twice wastes a
machine; a test that runs nowhere silently stopped being run, and nothing
anywhere will say so.

**Every node computes the same partition** without talking to any other node -
each asks for the whole split and keeps its slice. So the answer is
deterministic down to how ties are broken, because a tie broken by chance hands
two nodes overlapping work and leaves a hole.

The partition itself is longest-processing-time-first: sort by cost descending,
give each item to whichever node is cheapest so far. It is within 4/3 of optimal
and the input is estimates anyway - what matters is that the big items are
placed first, since placing them last is exactly how one node ends up eleven
minutes long.

### When there is no history

It still answers, with a `note` on stderr saying the split came from nothing.
The alternative - an error - leaves a node with no list, which turns a
missing-history problem into a broken build. A file nobody has timed is assumed
to cost what a typical file costs rather than nothing: zero would mean adding it
never changes which node is cheapest, so every new file lands on the same one.

## On the pull request

The checks tab carries a **Tests** panel: which tests failed and what they said,
per-suite counts, and the sentence that is the reason to build any of this.

> This branch made 1 test flaky
> `unit/b.test.ts` newly-flaky
>
> 6 unreliable tests were already flaky on main, so this branch did not cause
> them.

"There are seven flaky tests" is a sentence a reviewer learns to skip, because
it is true of every pull request in the repository - flakiness elsewhere is
stored as a property of the test, so a test that has been unreliable on main for
a month decorates every branch that touches nothing near it.

So flakiness is measured twice, by the same rule, over two slices of history:
this branch's, and the base's. The difference is the finding, and it is the only
part a reviewer has to act on.

A commit nothing has reported results for says so. It is not shown as green -
that is the state a misconfigured collector leaves every commit in, and
rendering it like a passing suite is how nobody notices for a month.

## Trends, on the repository's own page

`/{owner}/{repository}/tests` - a Tests tab beside Runs. Three questions, and
they are the ones nobody writes the SQL for:

- **Where the time goes.** Ranked by *total* time over the window, not by the
  slowest single run: a 40ms test that runs in every one of two thousand
  executions costs more than the one nine-second test, and the total is what the
  wall clock feels.
- **Least reliable.** Failure counts and the passing share, with an owner
  column, so a flaky test has an addressee.
- **What is switched off**, and how much of it is past its review date.

The page states its own evidence. A test with fewer than five runs in the window
is not ranked, and the count of what was left out is shown - a reliability
figure computed from four executions is not a measurement, and presenting it as
one teaches people to distrust the rest of the page.

## Retention, and what the history costs

Execution rows are the one table here that grows with how often *machines* run
rather than with how much people do: two thousand tests reported on every commit
writes two thousand rows per push.

- **`test_retention_days`** is an instance setting, default **90**. Zero keeps
  everything, and the description says so, because that is the one value whose
  cost has no ceiling.
- **About 220 bytes per execution**, indexes included. Two thousand tests, ten
  pushes a day, ninety days is roughly **400MB**. Worth knowing before you point
  a collector at a large suite rather than after.
- A daily job deletes executions past the window, and the runs they belonged to,
  in batches - the first sweep on an instance that has been recording for a year
  is otherwise one statement against millions of rows, holding a lock long
  enough for pushes to time out.

**Tests, suites, mutes, owners and reasons are never swept.** Those are
decisions somebody recorded; the executions are data that accumulated. A sweep
that took the mute with the history would silently un-quarantine a test.

## Monitors

A rule that watches a suite and says something **once**, when the answer
changes.

```sh
curl -sX POST https://reviewos.example/api/repos/tests/monitors \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"create",
       "suite":"browser","condition":"fail_rate","threshold":5,"window_days":14}'
```

| Condition | Measures | Threshold is |
|---|---|---|
| `fail_rate` | share of executions that failed | a **percentage**, 0 to 100 |
| `flaky` | tests that disagree with themselves | a count |
| `duration` | what one run of the suite costs | milliseconds |

`fail_rate` is a percentage rather than a share from zero to one because
somebody typing `5` at a field that wants a share has written five hundred
percent, and the monitor they just made can never fire - which is worse than no
monitor, since it reads as covered.

**Only the transition is an event.** "Is the failure rate above five percent" is
true every hour it is true; a rule that acted on the answer would send the same
alarm twenty-four times a day, and the channel it arrives on is the one that has
to work the day it matters. So a monitor in alarm for a month sends one message.

The recovery is an event too. Somebody told a suite is unreliable has no way to
learn it is fine again, and a dashboard that only ever goes red is one people
stop reading.

A **muted test cannot put a monitor into alarm.** Its failures are already set
aside everywhere else, and counting them here would alarm on exactly the tests
somebody has already decided about.

And **a measurement it could not take is not a recovery**: a suite nobody
reported for this week has no failure rate, and reading that as "back to normal"
would clear an alarm because the reporting broke - which is when the alarm
matters most.

Evaluated hourly. `operation: "evaluate"` runs it now, which is what you want
the moment after writing a rule. Transitions arrive as the `test:monitor`
webhook, with `alarm` or `recovered` in `action` - webhook-only, because nobody
wants an inbox entry every time a suite wobbles.

Both dates come back on a monitor: `evaluated_at` moves every hour,
`changed_at` only on a transition. The difference is how you tell "this rule
says everything is fine" from "this rule has not run since March".

## What is not built yet

Stated plainly, because a half-built feature you discover yourself is worse than
one that was never promised:
