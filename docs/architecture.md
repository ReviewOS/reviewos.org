# Architecture

Where things live, and how a request becomes a git operation. Written for somebody about to change
the code, so it says why as often as what.

## The shape of it

One process serves everything: the pages, the JSON API, and the git wire protocol. Postgres holds
the rows. Repositories are ordinary bare git repositories on a disk this process can reach. Jobs run
in the same application, off a database-backed queue.

That is the whole topology, and it is a decision rather than an early stage. An instance that needs
a message broker and three services to host ten repositories is an instance nobody self-hosts, and
self-hosting is the product.

| Path | What lives there |
|---|---|
| `app/Actions/` | One action per endpoint, grouped by domain: `Git/`, `Pull/`, `Issue/`, `Checks/`, `Runner/`, `Repo/`, `Auth/` |
| `app/Models/` | `defineModel()` definitions. Migrations are generated from these, never hand-written |
| `app/Jobs/` | Everything that must survive the response: pushes, imports, mirrors, webhooks, notifications |
| `app/Ops/` | Running an instance: the boot check, health, metrics, shutdown, settings, audit |
| `app/Webhooks/` | The delivery envelope and the payload contract |
| `routes/` | Route files. `api.ts` is the JSON API; `git.ts` is the wire protocol, mounted at the root |
| `resources/views/` | stx pages, file-based: `resources/views/[owner]/[repository]/pull/[number].stx` is a URL |
| `storage/repos/` | The bare repositories, as `{owner}/{repository}.git` |

## A request becomes a git operation

`git clone https://forge.example.com/git/anna/checkout.git` is four HTTP requests, and none of them
are under `/api` - git asks for `{base}/info/refs` and then posts to `{base}/git-upload-pack`, so the
wire protocol is registered at the root in `routes/git.ts`, mounted with an empty prefix.

It is registered a second time under `/git`, and that is the copy a client reaches. A deployed
instance runs the pages and the API as two processes: the page process owns `/` and proxies to the
API only what `config/server.ts` names, and a prefix is the only wildcard that configuration has.
Without the mount the opening GET was answered by the page server with a rendered HTML page, and
every clone of every repository failed with `repository not found` - which reads as a typo or a
permission rather than as a missing route, and is why it went unnoticed for as long as it did.

1. **Resolve.** The path is parsed into an owner and a repository, and the repository is looked up.
2. **Authorize.** The token in Basic auth is resolved to an account and its scopes. A repository the
   caller cannot read answers **404**, never 403: a 403 confirms that a private repository exists,
   which is the one fact the visitor is not entitled to.
3. **Spawn.** `git upload-pack` or `git receive-pack` runs against the bare repository, and its
   stdout is the response body.
4. **Stream.** Nothing is buffered. A packfile for a real repository is far larger than anything
   worth holding in memory, and buffering would pass every test written against a small repository
   and fall over on the first big one.

Everything that touches a repository on disk goes through `app/Actions/Git/`. Nothing else in the
codebase knows the storage layout, and there is no git library: the binary is a declared dependency
and is the supported path. A reimplementation of git in TypeScript is a second implementation to be
subtly wrong, and it would be wrong about the cases that matter least often and cost most.

## A push, end to end

A push is where the forge learns anything, so it is worth following in full.

**Before the objects are accepted**, git runs the `pre-receive` hook this instance installed. The
hook posts to a loopback endpoint carrying `GIT_HOOK_SECRET`, and the answer decides the push:

- Branch protection rules: who may push to this ref, whether it may be force-pushed, whether reviews
  and checks have to have passed.
- Secret scanning, over the objects in the quarantine directory git hands the hook. Rejecting here
  is the point - a secret that lands and is then removed is a secret that was published.
- Push protection bypasses, when somebody deliberately asked for one, recorded in the audit log.

**After they are accepted**, `post-receive` reports what moved. That work is queued rather than done
in the hook, because a push should not wait for a webhook delivery to somebody else's slow server:

- `pushed_at`, the activity feed, and repository size
- Issues closed and cross references written from the commit messages
- Pull requests whose head moved, which invalidates reviews written against the old one
- Webhooks and check runs waiting on the new head

Without `GIT_HOOK_SECRET`, the hook cannot post back and none of it happens: the objects land and
the forge learns nothing. That is why the endpoints answer 404 without the secret rather than
accepting anything - a default shared secret is a published shared secret.

## The diff, which is the product

A review of a hundred-file change is the thing this forge is arranged around, so the diff has more
machinery behind it than anything else.

- **`git diff` is streamed out of the process**, split per file as it arrives. A large diff starts
  rendering before git has finished producing it.
- **The manifest is NDJSON.** One line per file, with enough metadata - hunk ranges, estimated
  heights - for the client to lay out a scrollbar that does not jump as files load.
- **Rows are rendered on the server.** The client virtualizes: it mounts the files near the viewport
  and keeps the rest as measured space. A diff viewer that renders a hundred files of DOM is a diff
  viewer that locks the tab.
- **Small diffs skip the round trip.** Rows for the first `DIFF_INLINE_ROWS_BUDGET` bytes ride along
  in the manifest, so an ordinary pull request needs one request rather than two.
- **Syntax highlighting is a worker**, with grammars loaded lazily and cancellation when the reader
  scrolls past.
- **Threads survive a force-push.** A comment records the head it was written against, so it can be
  placed in a later diff rather than orphaned.

## Checks and CI: two planes

The control plane is this application: workflows, runs, jobs, leases, logs, artifacts. The execution
plane is a runner, which is a separate process holding a lease.

The split is a security boundary rather than a deployment convenience. A runner executes code from a
pull request, which means it must be assumed hostile: it gets a credential good for one job, it
cannot read another job's secrets, and everything it reports is checked against the lease it holds.
Delivery is at-least-once and a lapsed lease returns the work to the queue, so a runner that stops
talking loses its job rather than stalling the run. [The CI threat model](./ci-threat-model.md) is
the long version, and [the runner protocol](./runner-protocol.md) is what a runner has to implement.

The older commit-status API works too, so any CI that can POST a status can turn a branch rule
green without knowing anything about runners.

## Data

Models describe the schema, validation, factories, relationships and behaviour in one place, and
migrations are generated by diffing them against the database:

```bash
./buddy generate:migrations   # diff models against the schema, emit SQL
./buddy migrate               # apply it
```

Hand-writing a migration is how a schema and a model stop agreeing. The generated file is reviewed
before it runs, which is the step that catches a rename being read as a drop and an add.

## Frontend

stx pages, server-rendered, with islands where interactivity is worth it: `x-data` scopes hydrated
by a small runtime, stores for anything shared, and no direct DOM access in templates.

The one thing worth knowing before you debug a blank page: **stx fails silently**. A throw in a
`<script server>` block renders the page with every variable undefined rather than reporting
anything, so the symptom is a not-found branch or an empty region, never a stack trace. `STX_DEBUG=1`
surfaces the real error, and the dev server caches compiled components in memory, so restart it
rather than trusting an edit to take.

## Where the decisions are written down

In the code, next to what they decided. A file that explains why it is shaped the way it is has
answered the question the next person would otherwise ask a maintainer, and the roadmap in
[docs/todo](./todo/) records what was deliberately deferred and why.
