# The runner protocol

What a machine has to say to take work from this instance, and what it gets
back. Everything here is HTTP and JSON: there is no SDK to install, and a runner
written in an afternoon in any language is a supported runner.

The whole surface is five endpoints. That is deliberate - a protocol an operator
can hold in their head is one they can debug at three in the morning with
`curl`.

**If you do not want to write one**, this instance ships a runner that speaks it:
`./buddy build:runner --target linux-x64` compiles the executor into a single
file with nothing to install on the machine that runs it. See
[self-hosting](./self-hosting.md#a-fleet). The rest of this page is for the case
where you would rather write your own, which is a supported thing to do.

## Registering a runner

A runner is a row an operator creates, with a token it holds and a scope that
says what it may see:

| Scope | Reaches |
|---|---|
| `instance` | every repository on this instance |
| `organization` | every repository owned by that organization |
| `repository` | that repository, and nothing else |

The token is stored as a SHA-256 hash, so it is shown once at creation and never
again. A registration token in a database in plain text is one in every backup.

**Labels** are one per line, and a job's `runs-on` must be satisfied by them.
They are a matching rule, not a permission: reach is decided by scope first, and
a runner registered for one repository being handed another's source is not a
scheduling mistake but the instance giving somebody's private code to a machine
its owner chose.

## Versioning

Every request may carry the version it speaks:

```
X-Runner-Protocol: 1
```

Every answer says what this server speaks, on the ordinary responses as well as
the refusals:

```
X-Runner-Protocol-Supported: 1
```

A runner that sends no version is assumed to be speaking the oldest one this
server still accepts, so a fleet written before the header existed keeps working
and learns what to send from the response.

A version this server cannot speak is refused with **426 Upgrade Required**, in
either direction, and the body says which end is behind. Upgrading a hundred
machines and upgrading one server are different afternoons, and a runner left to
guess produces a job that hangs rather than an error anybody can act on.

The check runs before the credential is looked at: a runner that cannot be
spoken to is going to misread whatever it is handed, and telling it the token is
fine first only delays the confusion.

## The five calls

All five are `POST` and all five are exempt from CSRF, because a machine holds a
bearer token and no cookie - there is no ambient credential for a forged
cross-site request to ride. Four of them take and return JSON; the artifact
upload takes the file itself as the body, for the reason given there.

### `POST /api/runner/claim`

Authenticated with the **registration token**. Asks for one job.

```json
{ "job": null }
```

**No work is a 200**, not a 404. A runner polling an idle instance is not making
a mistake, and an error status for the common case fills a fleet's logs with red
that means nothing.

When there is work, the answer carries what the job is, the steps to run, and a
**credential minted for this claim alone**. Everything afterwards authenticates
with that, not with the registration token: the registration token is installed
once and never rotated, and it must not be the thing travelling on every call.

It carries no repository secret. By [the threat model](./ci-threat-model.md) an
untrusted run - a pull request from a fork - never receives one at all.

### `POST /api/runner/heartbeat`

Authenticated with the **job credential**. Extends the lease.

A lease is sixty seconds. Short and renewed, rather than long: a job held by a
machine that fell over is stuck for as long as its lease, and the machine cannot
be asked.

**A refused heartbeat is a 409**, and it means stop working. The lease lapsed or
the run was cancelled, and anything reported afterwards will be refused anyway.

### `POST /api/runner/logs`

Authenticated with the **job credential**. Appends output.

```json
{ "sequence": 1, "content": "compiling\n", "stream": "stdout" }
```

The sequence is the runner's own counter, and it is what makes at-least-once
delivery safe: sending the same chunk twice stores it once and answers
`duplicate: true`. A runner that did not hear an answer should send it again.

**Or as events**, when the runner has more than bytes to say:

```json
{
  "sequence": 2,
  "events": [
    { "type": "group", "text": "Install dependencies" },
    { "type": "line", "text": "bun install", "at": "2026-08-13T10:00:01Z", "stream": "stdout" },
    { "type": "endgroup" }
  ]
}
```

Text is not deprecated and will not be. A runner that sends what its build
printed is doing the honest thing; events exist for the four things text cannot
carry and that cannot be recovered from it afterwards:

- **which lines were grouped**, because `::group::` is a marker one CI product
  uses and a string somebody's build may legitimately print;
- **when the job printed each line**, because the time this server received a
  chunk is not that - a runner batching a hundred lines for one round trip would
  have them all arrive in the same millisecond;
- **which stream each line came from**, since a chunk carries one `stream` and a
  runner interleaving stdout and stderr would otherwise have to split every
  chunk or lie;
- **where colour started and stopped**, so a page can render it or ignore it per
  reader rather than showing escape bytes as text.

Three event types: `line`, `group`, `endgroup`. Nesting is flat, like every CI
product that has this. A group nobody closed is closed at the end, because a
build that fails inside one never gets to close it - and that is the group
somebody came to read.

The answer reports how many events were understood. An event type this server
has not learned is **dropped, not refused**: a newer runner mid-fleet-upgrade
should not lose the lines around it, and the protocol version is what tells it
the server is older.

The text form is stored alongside, derived from the events, so everything that
reads a log as text keeps working without knowing any of this exists.

There is a ceiling on a job's total output, enforced on the way in. Past it the
append is **accepted and dropped** rather than refused - a 4xx there makes a
correct runner retry a chunk that will never be wanted.

### `POST /api/runner/report`

Authenticated with the **job credential**. Records what happened.

```json
{ "state": "succeeded" }
```

**A duplicate report is a 200**, marked `duplicate: true`. At-least-once
delivery means a correct runner will say it twice, and answering 409 to that is
how one retries forever.

`cancelled` is the one report that survives a revoked lease. When a run is
cancelled every lease it holds is expired at that moment - which is what stops a
worker that already lost its connection publishing a success over a run somebody
stopped - and a runner that heard the cancellation, stopped, and came back to
say so is still the holder. "I stopped" cannot fabricate a verdict the way "I
succeeded" can, so that one is accepted and nothing else is.

A run whose runner never acknowledges is ended by the control plane two lease
periods after the request. Cooperative first, forceful after a deadline.

### `POST /api/runner/artifacts`

Authenticated with the **job credential**. Publishes a file for somebody to
collect later.

**The body is the file.** A runner is a program, the thing it has is a stream of
bytes, and asking it to build a multipart form around them would mean every
implementer pulling in a library to send one file. The name and the retention
ride in headers, so nothing needs parsing before the bytes can be written.

```bash
curl -X POST "$SERVER/api/runner/artifacts" \
  -H "Authorization: Bearer $JOB_TOKEN" \
  -H "X-Artifact-Name: coverage.lcov" \
  -H "X-Artifact-Retention-Days: 30" \
  --data-binary @coverage.lcov
```

The answer carries the SHA-256 the bytes were stored under and the date the
artifact stops being available. Storage is content-addressed, so the same file
published by eight jobs of a matrix costs one copy, and a re-run producing
identical output costs nothing.

**The same name twice** is idempotent when the content matches - a 200 marked
`duplicate`, which is what a runner that did not hear the first answer gets. The
same name with *different* content is a 409: silently replacing an artifact
somebody may already have downloaded leaves two people holding different files
under one name and no way to tell.

There are two ceilings, per artifact and per run. One without the other is not a
ceiling - a per-artifact limit alone is walked around by a matrix of fifty jobs
each uploading just under it.

Artifacts are **not** dependency caches. A cache is an optimisation the instance
may drop whenever it likes; an artifact is something a person asks for by name
three weeks later, and the two want opposite retention rules.

## Upgrading a fleet

1. Upgrade the server first. It keeps speaking to every runner version in its
   supported range, and a fleet is never upgraded atomically.
2. Upgrade runners at whatever pace suits. Each one that reconnects is checked,
   and any that is too old is refused with a sentence saying so.
3. Watch `X-Runner-Protocol-Supported` on ordinary responses. A version about to
   be retired shows up there long before it stops working.

Retiring a version - raising the minimum - is a breaking change for anybody who
has not upgraded, and it belongs in a release note rather than in a patch.
