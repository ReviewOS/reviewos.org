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

## What is not built yet

Stated plainly, because a half-built feature you discover yourself is worse than
one that was never promised:

- **Test splitting** - distributing a suite across parallel jobs by historical
  timing. The timings are recorded; the client that consumes them is not
  written.
- **Monitors and actions** - a rule that watches a test and raises an alarm once
  per transition.
- **Trends and the pull request surface** - reliability and duration over time,
  and telling a test a branch made flaky from one that was already flaky on the
  base.
- **Retention** - execution rows are kept indefinitely today. Reporting a large
  suite on every commit will grow that table, and there is no policy yet.
