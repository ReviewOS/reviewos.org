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
docker compose exec -T postgres psql -U postgres reviewos \
  -c "UPDATE users SET is_admin = true WHERE handle = 'you'"
```

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
| Postgres | Everything else: accounts, pull requests, reviews, threads, tokens | The conversation around the code. |

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
| `DB_CONNECTION` | `postgres` | The driver. |
| `DB_HOST` | `127.0.0.1` | `postgres` inside compose, which is the service name. |
| `DB_PORT` | `5432` | A stray space or quote here reads as a connection refused, which sends people to look at the network. |
| `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD` | `reviewos` / `postgres` / - | Postgres has exactly one role in the pantry-managed local cluster, so `postgres` is not a placeholder. |
| `AUTH_IDLE_TIMEOUT` | `0` (off) | How long a session may go **unused** before it stops working, in milliseconds. Distinct from how long it may live at all: an absolute limit alone lets a browser left open on a machine somebody walked away from keep working for its full term. `1800000` is thirty minutes. A value that is not a number stops the instance rather than quietly meaning "off". |
| `MAIL_HOST` and friends | none | Absent means no password reset and no notification email can be sent, silently. Fine for an invite-only instance, and worth knowing. |
| `SEARCH_HOST` / `SEARCH_KEY` | - | Meilisearch. The instance works without it; the search page is empty. |

`buddy instance:check` reads all of these and says which are wrong, why, and
what to do. It is the same check the boot path runs, so there is nothing to
learn twice.

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

## The queue

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
docker compose stop app worker

docker compose exec -T postgres pg_dump -U postgres reviewos | gzip > backup/db.sql.gz
tar -czf backup/repos.tar.gz -C /var/lib/docker/volumes/reviewos_repos/_data .
tar -czf backup/uploads.tar.gz -C /var/lib/docker/volumes/reviewos_uploads/_data .

docker compose start app worker
```

Stopping the two application containers is what makes them the same moment. An
instance that cannot take that pause wants a filesystem snapshot or a replica
instead, and both are outside what this file can honestly describe.

### Restoring

```sh
docker compose down
docker volume rm reviewos_repos reviewos_uploads   # only when replacing them wholesale
docker compose up -d postgres

# Into an EMPTY database, and stopping at the first error. Both matter - see below.
docker compose exec -T postgres dropdb -U postgres --if-exists reviewos
docker compose exec -T postgres createdb -U postgres reviewos
gunzip -c backup/db.sql.gz | docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 reviewos

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
createdb -U postgres reviewos_rehearsal
gunzip -c backup/db.sql.gz | psql -U postgres -v ON_ERROR_STOP=1 reviewos_rehearsal
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
