# Self-hosting ReviewOS

Self-hosting is the product, not a mode of it. This is what running one takes,
including running one badly and getting it back.

## The short version

```sh
git clone https://github.com/ReviewOS/reviewos.org
cd reviewos.org
cp .env.example .env          # then edit it, see Configuration below
docker compose up -d
docker compose exec app bun run --bun ./buddy migrate
```

Then check it, before anybody else does:

```sh
docker compose exec app bun run --bun ./buddy instance:check
```

That prints the configuration problems and the state of the database, the queue
and repository storage. It exits non-zero when something is fatal, so it works
in a start script without anybody parsing its output.

## One host, end to end

Most instances are one machine, and that is what this section is. Everything
below assumes the compose file in this repository, a domain pointed at the host,
and nothing else.

**1. TLS, in front.** Terminate it at a reverse proxy rather than in the
application. Caddy is two lines and gets a certificate on its own:

```
forge.example.com {
  reverse_proxy localhost:3000
}
```

Set `APP_URL=forge.example.com` to match. The application reads
`x-forwarded-proto` to decide whether to mark the session cookie `Secure`, which
Caddy and nginx both send by default - and getting that wrong is a login form
that appears to work and returns you signed out.

**2. Bring it up, then check it.**

```sh
docker compose up -d
docker compose exec app bun run --bun ./buddy migrate
docker compose exec app bun run --bun ./buddy instance:check
```

**3. Make the first account, then close the door.** Registration is open by
default so the first person can get in - the first account is exempt from the
closed setting for the same reason, otherwise an instance closed before anybody
signed up is one nobody can administer. Register through the interface, then:

```sh
docker compose exec -T database mysql -uroot -p"$DB_PASSWORD" reviewos \
  -e "UPDATE users SET is_admin = 1 WHERE handle = 'you'"
```

(On Postgres: `docker compose exec -T database psql -U postgres reviewos -c
"UPDATE users SET is_admin = true WHERE handle = 'you'"`.)

and turn registration off from the settings API, or leave it open if this is a
public instance.

**4. Back it up on a timer**, because a backup somebody runs by hand is a backup
that stopped in March. A `systemd` timer or a cron line, calling the two
commands in [Backup](#backup) together - and **rehearse the restore the same
day**, which is its own section and is the only part of this page that people
skip and regret.

```
0 3 * * *  cd /srv/reviewos && ./backup.sh >> /var/log/reviewos-backup.log 2>&1
```

**5. Watch two things.** `/api/health` for whether it is serving, and
`/api/metrics` for whether it is coping. Both are described below. If you run
nothing else, run something that alerts on the health endpoint going 503 - the
instance takes itself out of rotation on a failed database or an unwritable
repository volume, and that is the signal worth waking up for.

## Without Docker

The compose file is the shortest path, not the only one. On a machine you
manage directly, pantry installs the toolchain into the project rather than onto
the system, which is what makes this reproducible without containers:

```sh
git clone https://github.com/ReviewOS/reviewos.org
cd reviewos.org
cp .env.example .env          # then edit it, see Configuration below
./buddy setup                 # Bun, Postgres, git, gnupg; creates the database
./buddy migrate
./buddy instance:check
```

Then run the three processes under whatever supervises this machine. A systemd
unit each, all with `Restart=always`, all in the project directory:

```ini
# /etc/systemd/system/reviewos.service
[Service]
WorkingDirectory=/srv/reviewos
ExecStart=/srv/reviewos/buddy serve
Restart=always
KillSignal=SIGTERM
TimeoutStopSec=30
```

```ini
# /etc/systemd/system/reviewos-queue.service
[Service]
WorkingDirectory=/srv/reviewos
ExecStart=/srv/reviewos/buddy queue:work --concurrency 4
Restart=always
KillSignal=SIGTERM
TimeoutStopSec=30
```

```ini
# /etc/systemd/system/reviewos-scheduler.service
[Service]
WorkingDirectory=/srv/reviewos
ExecStart=/srv/reviewos/buddy schedule:run
Restart=always
KillSignal=SIGTERM
TimeoutStopSec=30
```

`TimeoutStopSec=30` and `SIGTERM` matter more than they look: the application
stops by reporting unhealthy, waiting for the load balancer to notice, then
draining in-flight work, and the total is deliberately under the 30 seconds
systemd waits before `SIGKILL`. See [Stopping and restarting](#stopping-and-restarting).

The reverse proxy, the backups and the checks below are the same either way -
only the process manager differs.

## What it costs to run

Measured on this instance rather than estimated, because sizing guidance from
guesses is how people either over-provision by ten times or discover the real
number during their first bad afternoon. **The machine: 11 cores, 18 GiB.** The
data: 313 repositories, 719 accounts, 688 pull requests, 198 MB of git on disk,
a 17 MB database.

| What | Measured |
|---|---|
| Boot to serving | 88ms |
| Resident memory, idle after boot | 259 MB |
| Resident memory, after a hundred requests | 389 MB |
| `/api/health` | 1.1ms p50, 2.9ms p95 |
| A server-rendered page | 31ms p50, 106ms p95 |
| Ref advertisement, 2,489 refs, 190 MiB pack | 17-19ms warm, 44ms cold |
| A 20-commit diff on that repository | 42-57ms |
| A full clone of it, pack generated fresh | 5.2s of one core |

What those numbers mean for a machine:

- **Memory is the first thing you will run out of, and it is the application
  rather than git.** Budget 512 MB for the web process and another 512 MB for
  the worker, and note that the figure above climbs from 259 to 389 MB across a
  hundred requests - that is a runtime settling, not a leak, but plan for the
  higher number and not the lower. **1 GB total is the floor; 2 GB is
  comfortable for a team.**
- **Cores matter only for clones.** Everything the interface does is
  milliseconds; a full clone of a large repository is five seconds of one core,
  and the cost is roughly linear in pack size. Two cores serve a team without
  thinking about it. If your instance hosts one very large repository that CI
  clones on every build, that is the workload to size for - and the fix is a
  shallow clone in CI rather than a bigger machine.
- **Disk is git plus a rounding error.** The database here is 17 MB against
  198 MB of repositories, and it grows with *activity* rather than with code:
  roughly 24 KB per repository including its issues, pull requests and reviews.
  Take your repositories' size, double it for growth and packfile churn, and add
  a gigabyte for everything else.
- **The queue is idle almost always.** Its work is notifications, webhook
  deliveries and mirror syncs, all of which are waiting on somebody else's
  server rather than computing. Concurrency 4 on one core is not a bottleneck;
  the health endpoint reports queue depth so you can see it if it ever becomes
  one.

A rough shape, then: **2 cores and 2 GB for a team of twenty**, and the first
thing to increase is memory. An instance with a hundred people doing code review
on it is not meaningfully more expensive than one with twenty - the reads are
milliseconds and they cache - but one with CI cloning a large repository a
hundred times an hour is, and that is a bandwidth and core question rather than
a memory one.

## What holds state

**Two directories and one database.** Everything else in a deployment is
reproducible from the source, and these three are not.

| Path | What is in it | What losing it costs |
|---|---|---|
| `storage/repos` | Every bare git repository, as `{owner}/{name}.git` | The code. This is the one that cannot be rebuilt from anything else. |
| `storage/app` | Uploads and attachments | Images in issues and comments. |
| The database | Everything else: accounts, pull requests, reviews, threads, tokens | The conversation around the code. |

Everything under `storage/framework/` is a build artifact and a cache. It is
safe to delete and is rebuilt on the next boot, so do not back it up and do not
put it on the expensive volume.

`compose.yaml` mounts the two directories as named volumes, and the `Dockerfile`
declares them, so `docker inspect` reports the same list this table does.

## Configuration

Everything comes from the environment. Nothing is committed - `.env` is
gitignored, and `env_file: .env` in the compose file is what keeps a secret out
of a file that gets checked in.

The values that have to be right:

| Variable | Default | What it does, and what a wrong value looks like |
|---|---|---|
| `APP_KEY` | none | Signs and encrypts everything. Absent means sessions that do not survive a restart; short means it looks configured and is not. `buddy key:generate` writes one. |
| `APP_URL` | `reviewos.localhost` | The host this instance believes it is at, used in email links and redirects. A scheme is optional; a *path* is a mistake and appears twice in every link. |
| `APP_ENV` | `local` | `production` turns on the stricter half of the boot check. |
| `DB_CONNECTION` | `mysql` | The engine: `mysql` or `postgres`. Both are supported, the schema is generated for each, and the suite runs green against both. MySQL is the default from phase 17; Postgres is supported for one release cycle and then deprecated. See [Changing the database engine](#changing-the-database-engine) for moving an instance between them. |
| `DB_HOST` | `127.0.0.1` | `database` inside compose, which is the service name. |
| `DB_PORT` | `3306` | `5432` on Postgres. A stray space or quote here reads as a connection refused, which sends people to look at the network. |
| `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD` | `reviewos` / `root` / - | A pantry-managed MySQL initialises with `root` and no password, so `root` is not a placeholder. On Postgres it is `postgres`, whose cluster is initialised with exactly one role. |
| `AUTH_IDLE_TIMEOUT` | `0` (off) | How long a session may go **unused** before it stops working, in milliseconds. Distinct from how long it may live at all: an absolute limit alone lets a browser left open on a machine somebody walked away from keep working for its full term. `1800000` is thirty minutes. A value that is not a number stops the instance rather than quietly meaning "off". |
| `MAIL_HOST` and friends | none | Absent means no password reset and no notification email can be sent, silently. Fine for an invite-only instance, and worth knowing. |
| `TYPESENSE_HOST` / `TYPESENSE_PORT` / `TYPESENSE_API_KEY` | `127.0.0.1` / `8108` / `pantry-dev` | The search node. The instance works without it and the search page is empty. The development key is a development key: a search node reachable from anywhere, with a guessable key, answers anybody's questions about private repositories. |

This table is the triage list, not the reference. [Configuration](./configuration.md)
is generated from `.env.example` and the source that reads each variable, so it
cannot drift the way this table did: it said `SEARCH_HOST` and `SEARCH_KEY` for
months after the instance moved from Meilisearch to Typesense, and anybody who
followed it configured a search engine nothing reads.

`buddy instance:check` reads the values that have to be right and says which are
wrong, why, and what to do. It is the same check the boot path runs, so there is
nothing to learn twice.

### Secrets from a file

Any variable can come from a file instead, by naming the file in `<NAME>_FILE`:

```yaml
services:
  app:
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password
      APP_KEY_FILE: /run/secrets/app_key
    secrets: [db_password, app_key]

secrets:
  db_password:
    file: ./secrets/db_password
  app_key:
    file: ./secrets/app_key
```

This is the convention Docker secrets, Kubernetes projected volumes, systemd
credentials and every mainstream secret manager already produce, so an operator
who has one does not have to write a shell wrapper that reads the file and
exports the variable - which puts the secret back in the environment it was
trying to stay out of. An environment variable is readable by every process the
user runs, appears in `docker inspect`, and reaches the logs of anything that
prints its own configuration while somebody is debugging.

Three things worth knowing:

- **The environment wins when both are set.** Overriding a mounted secret for
  one run is the reason both ever exist, and a file that quietly won would make
  that override do nothing.
- **A trailing newline is stripped.** Every editor adds one, and a password with
  a newline on the end fails to authenticate against a server that is otherwise
  configured perfectly.
- **A file that is missing or empty stops the instance**, naming the path.
  Downstream it would read as "the variable is not set", and setting the
  variable is exactly the wrong response to a mount that did not happen.

Nothing else changes: an instance started from a `.env` works as before, which
is the common case on a single host.

## Email

Password resets, sign-in notifications for a new device, review requests and
digests all leave through here. There is one fact worth knowing before anything
else: **the default driver is `log`**, which writes what would have been sent
and sends nothing. In development that is what you want. In production it is a
password reset nobody receives, which the person on the other end reads as a
broken account rather than as a mail server that was never configured.

```sh
MAIL_MAILER=smtp
MAIL_HOST=smtp.example.com
MAIL_PORT=587
MAIL_USERNAME=forge@example.com
MAIL_PASSWORD=...
MAIL_ENCRYPTION=tls
MAIL_FROM_NAME=ReviewOS
MAIL_FROM_ADDRESS=no-reply@example.com
```

Four things that go wrong, in the order they do:

- **`MAIL_FROM_ADDRESS` on a domain you do not control.** It fails SPF and lands
  in spam, and the symptom is "notifications do not work" rather than anything
  about mail. Use a domain this instance is allowed to send for, and publish SPF
  and DKIM for whatever relays it.
- **Port 587 with `MAIL_ENCRYPTION=tls`** for submission with STARTTLS; 465 with
  `ssl` for implicit TLS. A mismatched pair connects and then hangs, which looks
  like the host being unreachable.
- **`MAIL_USERNAME=null`.** The example file carries the literal string, and it
  is treated as empty rather than as a user named "null" - so an authenticated
  relay with the username left at the default fails to authenticate and says so
  in the queue's log, not on the page somebody was looking at.
- **The queue has to be running.** Mail is queued, not sent inline, so a
  configuration that is right and a worker that is not running are
  indistinguishable from the interface.

Check it rather than guessing:

```sh
docker compose exec app bun run --bun ./buddy email:test
```

`buddy instance:check` warns when a production instance has no mail configured
at all. It is a warning rather than fatal: an invite-only instance where nobody
resets a password is a reasonable deployment, and it should be a choice rather
than a surprise.

## The queue

**Set `QUEUE_DRIVER=database`.** It is the deployment default and `.env.example`
ships it, but the framework's own fallback is `sync`, which runs every job
inline in the request that dispatched it. Under `sync` the push pipeline -
closing `fixes #12` issues, webhooks, notifications - runs inside the
post-receive request, so a slow webhook receiver holds somebody's `git push`
open. An instance that lost the variable loses nothing visibly; it just gets
slower and more fragile in exactly the places that are hard to attribute.

Jobs run in their own process. `compose.yaml` runs one:

```sh
bun run --bun ./buddy queue:work --concurrency 4
```

Separate from the web process because the two fail differently: a job that
wedges a worker should not stop anybody reading a diff.

**Concurrency 4 is the starting point, not a law.** Most jobs here are a git
process or an outbound HTTP request - waiting rather than computing - so the
useful number is higher than the core count and is bounded by what the disk and
the remote will take. Raise it if the queue depth reported by `/api/health` stays
above zero; lower it if the host's load average climbs while nothing is being
served.

Without a worker running, the instance looks fine and quietly stops doing
anything asynchronous: no mirror syncs, no webhooks, no notification email. The
health endpoint reports it - a job that has been waiting more than five minutes
is `degraded` with "is a worker running?" - which is the fastest way to notice.

## The scheduler

**A third process, and the one that is easiest to leave out.** A worker
processes what has been enqueued; the scheduler is what enqueues it.

```sh
bun run --bun ./buddy schedule:run
```

`app/Scheduler.ts` is the whole list, and none of it happens without this
running: the mirror sweep every five minutes, the lease reclaim every minute,
WAL reconciliation every ten, artifact expiry and the ref-drift audit hourly,
the repository checkpoint nightly.

This is worth being blunt about, because the failure is invisible in a way the
worker's is not. **A missing worker shows up as a growing queue. A missing
scheduler shows up as an empty one** - and an empty queue is what a healthy
instance looks like. Nothing errors, nothing backs up, no log line is written.
The only symptom is that scheduled things stop: mirrors go stale a day at a
time, expired artifacts are never deleted, and a runner's lapsed lease is never
returned.

**And the two fail together in a way that looks like one of them.** A scheduler
with no worker behind it is the same silence: the sweep fires on time, enqueues
`MirrorSyncJob`, and the queue grows with nobody to work it. That is what
happened on the instance this guide is written from - the scheduler unit was
running the whole time, and there was no worker for the `mirrors` queue at all,
so every mirror froze with a clean record. The first thing anybody noticed was a
repository page saying "synced 1 day ago". Check both before concluding
anything about either, and check the queue *by name*: a worker started without
`--queue` works `default` and leaves every other queue untouched.

`/api/health` reports it now: enabled mirrors that are far past their interval
with nothing errored against them are `degraded` with "is `buddy schedule:run`
running?". A mirror that is *failing* is deliberately not counted - that is a
credential to fix, not a clock.

**Exactly one.** Two web replicas do not mean two schedulers: the framework
takes a cross-cluster advisory lock per task, so a duplicate skips rather than
doubles, but a deployment that relies on the lock is a deployment where the host
that cannot reach the database runs everything twice. Run one, supervised, like
the worker.

### An older jobs table cannot be worked

`jobs` is created by a `CREATE TABLE IF NOT EXISTS`, so an instance whose table
predates the current definition keeps whatever types it was made with. This one
did, and both were fatal in a way nothing reports: `reserved_at` as a `date`
against a framework that writes a unix timestamp, and `payload` as a
`varchar(255)` against a JSON envelope. No worker can reserve anything - every
sweep dies with `operator does not exist: date <= integer` - and the queue depth
climbs with no explanation attached.

`/api/health` and `buddy instance:check` now probe the comparison rather than
trusting the table, and the repair they print is:

```sql
ALTER TABLE jobs ALTER COLUMN payload TYPE text;
ALTER TABLE jobs ALTER COLUMN reserved_at TYPE integer USING NULL;
```

Not a migration, deliberately: `database/migrations/` is regenerated from the
models and a hand-written file there is one the next regeneration deletes. This
is a repair for a database whose history is older than its schema, which is an
operator's job rather than the generator's.

### Every queue, worked by something

`buddy queue:work` takes `--queue`. **Without one it works every queue it finds**
- it reads the distinct queues out of the jobs table and re-reads them every ten
seconds - which is the shape this instance runs, because the alternative is a
list somebody has to remember to extend. This application dispatches onto seven:
`default`, `git`, `mirrors`, `search`, `notifications`, `webhooks` and `emails`.
A queue with no worker is not an error - it is a queue that grows quietly while
the feature behind it stops happening, which is how mirroring, notifications and
outbound email can all be "configured correctly" and all be dead at once.

`config/cloud.ts` runs that worker as a `daemon` under `sites.reviewos`, and
`tests/unit/cloud-queues.test.ts` checks both halves of it: that the queues are
covered, and that the command naming them names a file this repository actually
ships.

That second check exists because of how this failed the second time. ts-cloud's
`queues:` list writes one systemd unit per entry, and its Stacks driver builds
their `ExecStart` from `storage/framework/core/buddy/src/cli.ts` - the CLI of a
*vendored core*, which the core-less layout this application uses does not have.
Seven units, all crash-looping on `Module not found` every five seconds, while
`systemctl` reported them `activating (auto-restart)` and `/api/health` reported
the queue perfectly healthy - because a queue nothing fills has no depth to
complain about. If you deploy through ts-cloud and your queues are silent, read
`journalctl -u <slug>-<site>-queue-0` before believing the unit list.

### The name a job is dispatched under is the name of its file

There is no job registry. `Job.dispatch()` writes the job's `name` into the
queue row, the scheduler writes whatever string `.job()` was given, and the
worker turns either straight into a path: `app/Jobs/<name>.ts`. So a job called
`MeasureLanguages` in a file called `MeasureLanguagesJob.ts` cannot be run by
anything, ever, and the only trace is one line per attempt in a journal nobody
is tailing.

Every job here is named after its own file for that reason, and
`tests/unit/job-resolution.test.ts` fails when one is not - including for
`app/Scheduler.ts`, whose twenty tasks were all naming files that did not exist.

### Catching up after the queue was stopped

Fixing a stopped worker does not measure the repositories it did not measure.
Language breakdowns and contributor counts are queued by a push and by a mirror
sync, so a repository that has not changed since keeps its empty card until it
next does - which for a mirror means whenever upstream moves.

```sh
buddy repo:measure
```

Runs both measurements over every repository, in this process rather than
through the queue, printing each one as it goes. `--repository <id>` narrows it
to one; `--languages` and `--contributors` narrow it to one measure. Safe on a
live instance and safe to interrupt: each repository's rows are replaced in
place, so a run that stops halfway leaves what it reached measured.

`buddy search:index` is the same idea for the code-search shards.

## Pantry runs the instance, not just its dependencies

The canonical deployment is pantry plus a `.env`. No container runtime, and no
hand-written unit file: `config/deps.ts` declares this instance's own processes
beside its dependencies, so the app server and the queue worker are managed the
same way Postgres and Typesense are.

```sh
pantry start app
```

```sh
pantry start worker
```

```sh
pantry start scheduler
```

Each becomes a KeepAlive launchd agent (macOS) or systemd unit (Linux), with
its own logs under `~/.local/share/pantry/logs/<project>/`, restarting on crash
and surviving a reboot. `pantry inspect app` prints the status, the PID, the
port, the health check, and the exact command that is running.

Neither the worker nor the scheduler has a health check, for the same reason:
liveness is not the question. A worker's health is queue depth and a scheduler's
is whether scheduled work is actually happening, and `/api/health` reports both.
A check that only proved the process exists would report a wedged worker, or a
scheduler whose tasks all throw, as healthy - which is the failure worth
catching.

This needs pantry 0.11.31 or newer: project-defined services were built for
this, along with the two fixes underneath them (a per-project service port that
reaches the *peering* port too, and an `inspect` that reads the unit it
installed rather than recomputing a default).

The systemd units in "Without Docker" below still work and are still fine to
use. They are what to write when you want something pantry does not express;
they are no longer what you have to write to run this at all.

## Running more than one process

One app process and one worker is the default shape and needs nothing below.
The moment you run a *second* app process - for CPU, for zero-downtime
restarts, for a second box - three things that were quietly in-process have to
move out of the process, and all three are env switches rather than code:

| What | Setting | Why it breaks with two processes |
|---|---|---|
| Queue | `QUEUE_DRIVER=database` | Already the deployment default. `sync` runs jobs inline; `memory` is per-process. |
| Cache | `CACHE_DRIVER=redis` | Pull request presence rides the cache. In memory, each process has its own idea of who is looking at what, and readers flicker in and out depending on which process answered. |
| Broadcast | `BROADCAST_REDIS_ENABLED=true` | The websocket server is per-process. Without a shared bus, a comment posted through one process never reaches a reader connected to the other. |

The store behind the second and third is valkey - protocol-compatible with
Redis, BSD-licensed, and declared in `config/deps.ts` so pantry installs it
with everything else. Start it and point the connection at it:

```sh
pantry start valkey
```

```sh
# .env
CACHE_DRIVER=redis
BROADCAST_REDIS_ENABLED=true
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
```

The `REDIS_*` variables configure the cache, the broadcast bus, and (if you
switch the queue to redis) the queue, so the connection is written once.
Everything degrades rather than breaks if valkey is down - presence goes
quiet, live updates wait for a reload - which also means a misconfigured
store *looks* like a working instance with those two features missing. The
health endpoint is the fastest way to tell the difference.

The repositories on disk are the one thing this section cannot move: every
app process and every worker needs the same `storage/repos` filesystem.
Processes on one host share it by being on one host; a second box means NFS
or the phase 18 storage work, and NFS for git is a decision to make
deliberately, not a default to drift into.

## Running CI

Nothing executes a workflow until you say where. That is a deliberate default
rather than an omission: a forge that runs repository code the moment somebody
pushes a file has decided, on your behalf, that the code is trustworthy and the
machine is expendable.

For one team on one box, the answer is one command on the instance's own host:

```sh
./buddy runner:local
```

It registers a runner for this host the first time, keeps the credential in
`storage/framework/runtime/runner-local.token` (mode `0600`), answers to
`ubuntu-latest`, `self-hosted` and `local`, and starts taking jobs. A workflow
copied from GitHub with `runs-on: ubuntu-latest` runs without anything else being
configured, which is the point of that label being in the default set.

**It is not a security boundary, and it says so on every start.** A step runs as
the user who started the runner, on the host the control plane is on, with that
user's files and network. Right for one team running code they wrote; wrong for
anything where the code and the machine have different owners. A fork's pull
request is refused by the runner itself rather than by a setting, because
untrusted code on the control plane's own host is the one combination that turns
CI into somebody else's shell.

Stop it with ctrl-c. To run it as a service, run the same command under whatever
supervises your other processes:

```sh
bun run --bun ./buddy runner:local
```

### A fleet

For machines that are not the instance's, compile the runner into one file:

```sh
./buddy build:runner --target linux-x64
```

It is the same executor `runner:local` uses, compiled - not a second
implementation that drifts - and it needs nothing installed on the machine that
runs it: no Bun, no application checkout, no database driver. Targets are
`linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `windows-x64` and `host`.

On the instance, make a credential per machine:

```sh
./buddy runner:local --register --name build-01 --labels ubuntu-latest,self-hosted
```

Copy the binary and the credential to the machine, and run it:

```sh
./reviewos-runner --url https://reviewos.example --token <the credential>
```

Re-running `--register` with the same name rotates the credential rather than
making a second runner, so a leaked token is fixed by one command.

Two differences from a runner on the instance's own host, both because the code
is somewhere else: it **clones over HTTP** rather than from the bare repository
on disk, and it cannot register itself, which is what carrying a credential over
is for. A public repository clones anonymously; a private one needs a token whose
bearer may read it.

**Ephemeral runners**, which is what makes an autoscaling group safe to write:

```sh
./reviewos-runner --url … --token … --jobs 1                 # one job, then exit
./reviewos-runner --url … --token … --idle-timeout 300       # exit after 5 idle minutes
```

A machine that shuts itself down when the queue is empty costs nothing between
builds, and it knows whether it is mid-job where a scaler outside it would have
to guess.

Anything else that speaks [the runner protocol](./runner-protocol.md) works too:
it is five HTTP endpoints and no SDK.

When a run sits at "queued", the run page says why rather than spinning - no
runner registered, none that reaches this repository, or none carrying the labels
the job asked for, with the labels that *would* have matched listed next to it.

## Health

`GET /api/health` checks the three things that can be broken while the process
is fine, and answers **503** when one of them is:

```json
{
  "ok": true,
  "checks": [
    { "name": "database", "status": "ok", "ms": 3 },
    { "name": "queue", "status": "ok", "ms": 1 },
    { "name": "repository storage", "status": "ok", "ms": 2 }
  ]
}
```

- **database** - a real query against a real table, not `SELECT 1`. `SELECT 1`
  succeeds against a database with no schema in it, which is exactly what a
  deploy that has not run its migrations looks like.
- **queue** - reachable, and nothing stuck. Depth is reported rather than
  judged, because what counts as too many jobs depends on the instance.
- **repository storage** - present *and writable*. A volume that failed to mount
  leaves an empty directory that reads perfectly and accepts nothing.

`status` is `ok`, `degraded` or `failed`. **Degraded still serves**: taking an
instance out of rotation because something was slow turns a slow dependency into
an outage. Only `failed` produces the 503.

`?quick=1` skips the disk write, for a liveness probe running every few seconds.

## Stopping and restarting

`docker compose stop`, a rolling deploy, and `kubectl delete pod` all do the
same thing: send `SIGTERM`, wait, then `SIGKILL`. What happens in between is
what decides whether a push cut off mid-`receive-pack` leaves a repository with
objects and no ref.

The container's command is `buddy instance:serve`, which handles it in three
steps, in this order:

1. **Report unhealthy, keep serving.** For five seconds by default
   (`SHUTDOWN_LEAD_MS`). A load balancer polls every few seconds and needs two
   or three failures to take an instance out, and those seconds have to happen
   *before* the socket closes. Skipping this step is why "zero-downtime" deploys
   still drop requests.
2. **Stop accepting.** The socket closes.
3. **Wait for what is in flight**, up to twenty-five seconds
   (`SHUTDOWN_DRAIN_MS`). Under the thirty most orchestrators allow before
   `SIGKILL`, deliberately: a process that exits on its own terms has finished
   its writes, and one that is killed has not.

A second `SIGTERM` exits immediately, and the process says how much work it
abandoned. If you see that line, either the drain window is too short or
something is stuck - and those are different problems.

Give the orchestrator at least thirty-five seconds of grace, or it will
`SIGKILL` in the middle of step three and undo the point of steps one and two.

## Rate limits

On by default, and keyed to the **credential** rather than the address: one
agent looping must not exhaust the budget of the person who issued its token,
or of the other agents on the same account.

| Surface | Limit | Why that number |
|---|---|---|
| Reads | 5000/hour | The design asks clients to poll and then makes polling free with `ETag`, so punishing it would be incoherent. |
| Writes | 300/hour | A thousand reads are invisible; a thousand comments are somebody's afternoon. |
| Sign-in | 10 per 5 minutes, per address | Here the limit *is* the security control: a password is otherwise only as good as how fast somebody can guess. |
| Registration | 20/hour, per address | Loose enough for an office behind one NAT, tight enough that scripted bulk signup - which arrives in hundreds - does not work. |
| Password reset | 5 per 15 minutes, per address | It sends mail to somebody who did not ask for it. |
| Git over HTTP | 300/minute | A clone is one request. A person cannot reach this; a retry loop re-cloning can. |

Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset`, not only the refusals - a client that learns its budget
when it runs out cannot pace itself, only recover.

Per-token **creation** budgets - how many pull requests, comments and reviews a
token may create in an hour - are a separate limit with separate headers,
`X-Create-Limit` / `X-Create-Remaining` / `X-Create-Reset` / `X-Create-Action`.
Two budgets measuring different things cannot share one header name, and they
briefly did: a refusal whose body said "2 an hour" arrived under an
`X-RateLimit-Limit` of 300.

Counters are per process and in memory, so with several web processes the
effective limit is the configured one times the number of processes. That is
fine for what it is for: it turns an unbounded flood into a bounded one. Writing
a row per request to make it exact would cost every request to stop an
attacker's burst surviving a deploy, which is the wrong way round. (Per-token
*creation* budgets are different and do persist - see the agents section.)

## Metrics

`GET /api/metrics`, in Prometheus exposition format, because that is what every
scraper reads. A JSON shape of our own would be a format each operator has to
write an exporter for.

**Not public.** The numbers say how many repositories and accounts an instance
has, how much traffic it takes and when it is struggling - reconnaissance,
served conveniently - and it is the endpoint most likely to be left exposed,
because the scraper works either way and nothing complains. An instance
administrator may read it, or set `METRICS_TOKEN` and give the scraper a bearer:

```yaml
scrape_configs:
  - job_name: reviewos
    metrics_path: /api/metrics
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ['reviewos.example']
```

A stranger gets a 404 rather than a 403 - whether an instance exposes metrics at
all is worth not confirming.

What is there:

| Metric | What it answers |
|---|---|
| `reviewos_http_requests_total` | Request rate, by method, route pattern and status class. |
| `reviewos_http_request_seconds` | Latency, as a histogram. |
| `reviewos_git_operation_seconds` | How long git takes, by subcommand. This is where a forge's time goes. |
| `reviewos_queue_depth` / `reviewos_queue_oldest_seconds` | Work waiting. The second climbing steadily means no worker is running. |
| `reviewos_queue_depth` staying at zero *and* mirrors going stale | The opposite failure: nothing is enqueuing. See [The scheduler](#the-scheduler). |
| `reviewos_repositories_total` / `reviewos_users_total` | How big this instance is. |

Labels are **route patterns, never URLs**, and status is a class (`2xx`) rather
than a code. One series per repository on a forge with two hundred of them is a
cardinality explosion that takes the scraper down, and it is the most common way
a metrics endpoint becomes the outage it was meant to warn about.

Counters live in the process and reset when it restarts, which is normal for
Prometheus - a scraper detects the reset and `rate()` stays correct. With
several processes each reports its own, which is what a scraper expects.

## Error reporting

**Off unless you configure it.** This is self-hosted software, and software that
phones home by default is software people stop trusting. Nothing leaves an
instance until `ERROR_REPORTING_URL` is set.

| Variable | Default | What it does |
|---|---|---|
| `ERROR_REPORTING_URL` | none | Where to POST a report. Absent means off. |
| `ERROR_REPORTING_TOKEN` | none | Sent as `Authorization: Bearer`, if your collector wants one. |
| `ERROR_REPORTING_TIMEOUT_MS` | 3000 | How long to wait before giving up on a report. |
| `ERROR_REPORTING_WINDOW_MS` | 300000 | How long one error stays quiet after being reported. |

A webhook rather than an SDK for a named service: an SDK is a dependency, a
supply-chain surface, and a bet on which vendor you use, while a POST of JSON is
something Sentry, a Slack relay, an internal collector and a file behind `nc`
can all accept.

Three things matter more than delivery, and are worth knowing before you point
this at somebody else's service:

- **Credentials are redacted before anything is sent.** A stack trace and a
  request context are the two places credentials most reliably appear. Tokens
  keep their public prefix - which is what identifies the one to revoke - and
  lose the secret half; connection-string passwords, bearers, and anything in a
  field called `password`, `secret`, `token` or `authorization` are replaced. A
  commit sha is deliberately kept, because it is usually the most useful thing
  in the report.
- **A failed report never fails the request.** It is a consequence of a failure
  that already happened, and making it a second one is worse than losing it.
- **The same error is sent once per window**, with a count of how many were
  suppressed. An error loop otherwise fills your quota, costs you money, and
  buries the report that mattered.

Redaction removes credentials. It does not remove the shape of your instance -
paths, repository names, route patterns - so send reports over https and to a
collector you actually control.

## Backup

**Postgres and `storage/repos` have to come from the same moment.** A database
restored to a point after the repository snapshot has pull requests whose commits
are not on disk; the other way round has commits nothing references. Neither
reports an error, which is what makes this the important sentence on this page.

```sh
# Stop writes for the length of the snapshot. Seconds, not minutes.
docker compose stop app worker scheduler

docker compose exec -T database mysqldump -uroot -p"$DB_PASSWORD" \
  --single-transaction --routines --triggers reviewos | gzip > backup/db.sql.gz
tar -czf backup/repos.tar.gz -C /var/lib/docker/volumes/reviewos_repos/_data .
tar -czf backup/uploads.tar.gz -C /var/lib/docker/volumes/reviewos_uploads/_data .

docker compose start app worker scheduler
```

Stopping the two application containers is what makes them the same moment. An
instance that cannot take that pause wants a filesystem snapshot or a replica
instead, and both are outside what this file can honestly describe.

### Restoring

```sh
docker compose down
docker volume rm reviewos_repos reviewos_uploads   # only when replacing them wholesale
docker compose up -d database

# Into an EMPTY database, and stopping at the first error. Both matter - see below.
docker compose exec -T database mysql -uroot -p"$DB_PASSWORD" \
  -e "DROP DATABASE IF EXISTS reviewos; CREATE DATABASE reviewos CHARACTER SET utf8mb4"
gunzip -c backup/db.sql.gz \
  | docker compose exec -T database mysql -uroot -p"$DB_PASSWORD" reviewos

docker compose up -d
tar -xzf backup/repos.tar.gz -C /var/lib/docker/volumes/reviewos_repos/_data
docker compose exec app bun run --bun ./buddy instance:check
```

**`-v ON_ERROR_STOP=1`, and an empty target.** Without the flag `psql` reports
every error and still exits 0, so a restore that skipped half its tables looks
exactly like one that worked. Restoring over a database that still has the
schema is the usual way to produce those errors: a rehearsal here did it and
counted 517 of them - every `CREATE TYPE` and `CREATE TABLE` refused as already
existing - with a successful exit status and a shell script that carried on.

Then check that the repositories and the database agree:

```sh
docker compose exec app bun run --bun ./buddy instance:repos
```

That walks every repository row, confirms the directory exists and that `git`
can read it, and reports rows with no directory and directories with no row.
Both are ordinary after a restore from mismatched snapshots, and both are
invisible until somebody clones.

### Rehearsing it

**An untested restore procedure is a hope, not a backup.** Do it against a copy
before you need it, on the same day you set the backup up - restore into a
different database and a different directory, and check the pair without
touching what is running:

```sh
mysql -uroot -p"$DB_PASSWORD" -e "CREATE DATABASE reviewos_rehearsal CHARACTER SET utf8mb4"
gunzip -c backup/db.sql.gz | mysql -uroot -p"$DB_PASSWORD" reviewos_rehearsal
mkdir -p /tmp/rehearsal/repos && tar -xzf backup/repos.tar.gz -C /tmp/rehearsal/repos

DB_DATABASE=reviewos_rehearsal ./buddy instance:repos --root /tmp/rehearsal/repos
```

Compare that against `./buddy instance:repos` on the live pair. **The two counts
should be identical** - the restored copy should have exactly the problems the
original has, no more and no fewer. A restored copy with *more* problems means
the two halves of the backup came from different moments; one with fewer means
the dump is not of the instance you think it is.

`--root` exists because of this: the check used to read `storage/repos` and
nothing else, so the only way to test a restore was to restore over the live
instance first, which is the opposite of a rehearsal.

### Retention and offsite

Keep enough that a problem noticed late is still recoverable: daily for a
fortnight, weekly for a quarter, is a reasonable default for a small instance and
is a decision rather than a rule. A backup on the same host is not a backup -
it survives a mistake and not a disk - so copy it somewhere else, and encrypt it
before it leaves, because it contains every private repository on the instance.

## Upgrading

```sh
git pull
docker compose build
docker compose up -d
docker compose exec app bun run --bun ./buddy migrate
docker compose exec app bun run --bun ./buddy instance:check
```

Migrations run forward and are checked before they are applied. Take a backup
first - the one above, both halves - because a migration that fails halfway is
the case where having one matters, and it is the only case where the answer is
"restore" rather than "fix and re-run".

## Changing the database engine

An instance runs on MySQL or on Postgres, chosen by `DB_CONNECTION`, and moving
between them is a command rather than a page of instructions. What it is not is
online: the copy reads a snapshot, so a row written while it runs is a row it
does not carry. **Stop the application and the worker first.** The stop is the
part that matters, not how long the copy takes.

```sh
docker compose stop app worker scheduler
docker compose exec app bun run --bun ./buddy db:migrate-engine \
  --to mysql --host 127.0.0.1 --port 3306 --database reviewos --username root --password "$DB_PASSWORD"
```

It copies every table both databases share, and then checks its work: each
table is counted on both sides and hashed on both sides, over the *values* as
the application would read them. A boolean that arrived as the wrong number or
a timestamp shifted by the host's offset changes the checksum, which a row
count would not notice. It ends by naming the tables that did not match, and
exits non-zero if any did.

**The target schema has to exist first.** Create the database and apply the
corpus for the engine you are moving to:

```sh
DB_CONNECTION=mysql DB_MIGRATIONS_PATH="$PWD/database/migrations/mysql" ./buddy migrate
```

The path is absolute deliberately: passed the relative default the resolver
picks a directory of its own, which is how a Postgres run once wrote into an
empty `database/migrations/postgres` and orphaned everything already applied.

Then point `.env` at the new engine and start again:

```sh
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=reviewos
DB_USERNAME=root
DB_PASSWORD=...
```

```sh
docker compose start app worker scheduler
docker compose exec app bun run --bun ./buddy instance:check
```

**Nothing is ever written to the source.** Rolling back is putting the old
`DB_CONNECTION` back and starting the processes again - which is why the old
database should be left alone for a few days rather than dropped on the day.

**MySQL is the default from phase 17.** Postgres remains supported for one
release cycle and is then deprecated: an instance that stays on it keeps
working, and what it stops getting is new dialect-specific work. Phase 18's ref
ledger is built against MySQL's locking rather than Postgres advisory locks.

Both engines run the whole end-to-end suite in CI, on every push, and the
matrix is what makes that claim checkable rather than a promise.

## Agents and MCP

An instance serves the Model Context Protocol at `POST /api/mcp`, and there is
nothing extra to deploy: it is part of the application, so running one is
running the forge.

Point an agent at it with the URL and a fine-grained token:

```json
{
  "mcpServers": {
    "reviewos": {
      "url": "https://reviewos.example/api/mcp",
      "headers": { "Authorization": "Bearer ros_..." }
    }
  }
}
```

The tools are the review surface: list what is waiting, read a pull request,
read its diff as structured data, comment on a line, submit a review.

**The server holds no credential of its own.** Every tool call is a request to
this instance's public API carrying the token the connection authenticated with,
so an agent gets exactly that token's permissions and nothing that leaks from
the server process. There is no second permission check to configure and none to
get wrong.

Which means the token is the whole of the configuration, and the things worth
setting on it are:

- **Scopes.** A reviewing agent needs `pull_requests: write` and `contents:
  read`. It does not need `administration`.
- **Reach.** A token scoped to selected repositories cannot see the others, and
  they read as missing rather than forbidden.
- **Hourly limits.** How many pull requests, comments and reviews it may create
  in an hour. The first bad agent loop is not malice, it is a retry with no
  backoff, and the repository should survive it.

Two repository settings are worth knowing about before you point an agent at
anything protected:

- `count_machine_approvals` is **off** by default, so a machine account's
  approval does not satisfy a required-approvals rule. Its *objection* still
  blocks: declining to count a robot's yes is cautious, ignoring its no is not.
- A branch rule can require that a change written by a machine account carries a
  human approval before it merges.

## Security

Report a vulnerability to `security@reviewos.org`. See
[SECURITY.md](../SECURITY.md) for what is in scope and what to expect.

Three things about a deployment, in the order they bite:

- **Terminate TLS in front of this.** Tokens and session cookies cross the
  network on every request. `buddy instance:check` warns when `APP_URL` says
  otherwise.
- **Keep `APP_KEY` secret and stable.** Everything signed and encrypted depends
  on it: rotating it invalidates every session, and leaking it is worse than
  leaking a password.
- **The backup is a security control.** It contains every private repository on
  the instance, so encrypt it before it leaves the host.

### The checklist

Everything below is covered somewhere on this page. Together it is what an
instance should look like before other people depend on it.

- [ ] TLS terminated in front, and `APP_URL` matching what people type
- [ ] `APP_KEY` generated with `buddy key:generate`, and backed up somewhere
      other than the instance
- [ ] `GIT_HOOK_SECRET` set to something random, and `buddy git:hooks` run since
- [ ] Registration closed, or open on purpose
- [ ] The first account made an administrator, and no others by accident
- [ ] Two-factor required for administrators, at least
- [ ] `METRICS_TOKEN` set, or `/api/metrics` unreachable from outside
- [ ] Postgres not listening on a public interface
- [ ] Backups running on a timer, encrypted, and **restored from once** rather
      than merely written
- [ ] `buddy instance:check` clean, in production mode
- [ ] Mail configured, or accepted as absent on purpose
- [ ] Dependency updates arriving as pull requests rather than as a task nobody
      has time for
- [ ] The search node, if you run one, on its own key rather than the
      development default

### Sessions

Everybody can see the browsers signed in as them, and end one, from their own
settings. The list records what each browser called itself and where it
connected from, because a list you cannot recognise a row in is a list where
"revoke" is guesswork - which is why "somebody is signed in as me on a laptop I
sold" has no answer in most self-hosted software.

Two things an operator decides:

- `AUTH_TOKEN_EXPIRY` - how long a session may live at all.
- `AUTH_IDLE_TIMEOUT` - how long it may live unused. Off by default, because
  this is a policy about your building rather than about the software, and one
  imposed by surprise reads to the person it logs out as being logged out at
  random.

A password reset ends every session, including the one that asked for it. That
is deliberate: the usual reason to reset a password is that somebody else may
have had it, and handing back a fresh session at the end would undo the one
useful thing the reset just did for every device except this one.

### Two-factor

TOTP, from any authenticator app. Ten recovery codes are issued with it and
shown once - store them somewhere that is not the device holding the app, which
is the whole point of them.

An organization can require it of its members. The requirement withholds the
member's *role* rather than blocking the sign-in, so somebody who has not
enrolled can still sign in and still reach the page where they would enrol -
they simply cannot reach that organization's repositories until they do. A
requirement that locks people out of the page where they would satisfy it is a
requirement that gets switched off.

**Passkeys** work alongside TOTP, and are the better of the two: the signature
carries the origin the browser is on, so a convincing copy of this sign-in page
on another domain gets a signature that verifies against nothing. TOTP does not
have that property - somebody who will type a password into a fake page will
type six digits into it too.

The one thing to get right is `APP_URL`. A passkey is bound to a domain, and one
registered against the wrong `rpId` is *invisible* to the browser afterwards
rather than broken loudly - which reads as "passkeys do not work here". Set it to
exactly the address in the browser's bar, including the scheme.

Either factor satisfies the requirement: somebody with a passkey is not also
asked for six digits.

### Single sign-on

OIDC, configured from the environment because a client secret in the database is
a client secret in every backup:

| Variable | Meaning |
|---|---|
| `SSO_ISSUER` | The provider's issuer URL. Discovery is read from `<issuer>/.well-known/openid-configuration`. |
| `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` | What the provider issued you. |
| `SSO_REDIRECT_URI` | Defaults to `<APP_URL>/api/auth/sso`. Register the same value at the provider. |
| `SSO_SCOPES` | Extra scopes beyond `openid email profile` - usually `groups`. |
| `SSO_TEAM_ORGANIZATION` | The handle of the one organization whose teams the provider manages. Unset means no group mapping. |

Send people to `/api/auth/sso`. Accounts are provisioned on first sign-in and
matched on the provider's `sub` forever after, so a person keeps their history
through an email change. An address is used only once, when linking a provider
account to a local one that already exists, and only if the provider says it
verified it.

**Group mapping removes as well as adds.** A group named `platform` puts
somebody on the `platform` team of the organization you named; a token that
stops carrying the group takes them off it. That is the point of federating -
one place to change access - and it is why `SSO_TEAM_ORGANIZATION` has to be set
deliberately rather than defaulting to something.

When somebody leaves, `deprovision` on the administration endpoint ends every
session and every token they hold. The account stays, because their reviews and
comments are part of the repository's history rather than their property.

### Mirroring a private repository

A mirror's credential is never stored on its row. `credential_ref` names one:

```sh
# The mirror was added with `--credential acme`
export MIRROR_TOKEN_ACME=ghp_...
# or, with a secret manager
export MIRROR_TOKEN_ACME_FILE=/run/secrets/acme-mirror
```

A mirror with no reference uses `GITHUB_TOKEN`, which is what a single-owner
instance mirroring its own repositories has. A public repository needs neither
for the code - but it does for its *metadata*, because the API that carries a
description, its topics and its issues is rate-limited to sixty requests an hour
without one.

**It has to be a credential that outlives the deploy.** This instance shipped
`secrets.GITHUB_TOKEN` from its own workflow, which is the Actions installation
token: it starts `ghs_`, and GitHub revokes it the moment the job finishes. The
release then held a token that had already been destroyed, so every metadata
sync answered `GitHub returned 401` while the code fetched perfectly - a forge
full of mirrored repositories, none of which had a description or a single
imported issue. Use a PAT, or mint a GitHub App installation token at deploy
time; `metadata_error` on the mirror row is where the 401 shows up.

The token reaches git in the remote URL rather than a config file, because a
config file is in every backup - and the error messages git prints are redacted
before they are stored, so an expired token does not end up on the mirror's
page.

### Keeping the dependencies honest

`buddy-bot.config.ts` configures both halves, and both run from
`.github/workflows/buddy-bot.yml`:

- **Updates**, grouped so a fast-moving first-party tree does not produce a
  pull request per package per day.
- **Advisories**, from OSV.dev. Every declared version is checked against the
  aggregated database, and an update that resolves a known vulnerability is
  split into its own pull request created *first* - a security fix behind twenty
  routine bumps is a security fix waiting for somebody to have an afternoon.

```sh
bunx --bun buddy-bot scan          # what is outdated, and what has an advisory
bunx --bun buddy-bot security      # static analysis of the workflow files themselves
```

The advisory query is a network call to `api.osv.dev` and nothing else - no
registry credential, no telemetry, no account. Set `security.enabled: false` if
this instance builds air-gapped; the update side still works from a local
registry mirror.

If you fork this to run your own instance, change `repository.owner` and
`repository.name` first. Ours said `stacksjs` for a while, inherited from the
template, which meant every pull request was aimed at a repository that does not
exist - and the failure mode is that nothing appears and nothing says why.

---

*The compose file is validated (`docker compose config`) but the image in this
repository has not been built end to end on the machine that wrote this file -
no daemon was running. Treat the `docker build` step as unverified until
somebody runs it.*
