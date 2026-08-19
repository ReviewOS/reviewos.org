# 18 - Storage scale-out

How the git tier grows past one box, written after reading Cursor's
[Git at any scale](https://cursor.com/blog/git-at-any-scale). Their Continuity system is the
reference architecture: every push persisted to a write-ahead log in object storage before it is
acknowledged, ref transactions linearized by compare-and-swap, bare repositories on local disk
demoted to a warm cache that any node can materialize on demand, and the stock git binary doing all
the git work. No consensus elections, no forked git, and reads on any replica verified against the
source of truth instead of trusted.

This phase adapts that shape to what ReviewOS is: self-hostable first, review-centric, and already
carrying a relational database on the critical path of every push. Two substitutions follow from
that, and the rest is Cursor's design.

**The database is the linearizer, not S3 conditional writes.** Cursor put both the log index and
the ref tips in object storage because object storage was the only shared dependency they wanted.
This forge already has a database on every install and on every authorized push, so the small,
contended thing (ref tips, WAL sequence) lives there as an ordinary CAS row update, and the big,
immutable thing (bundle bytes) goes to blob storage. Conditional-write support is also uneven
across the S3-compatibles self-hosters actually run, and a local-filesystem blob store has no CAS
at all - the database has real transactions everywhere. Per phase 17 this is designed MySQL-first:
per-repo `GET_LOCK` on one node, single-shard CAS transactions on a repo-sharded Vitess keyspace,
no Postgres advisory locks anywhere in the design.

**The blob store is a driver, and local disk is a first-class driver forever.** Most instances are
one box and must stay zero-extra-dependency. Object storage is opt-in, and wherever it appears the
S3 driver supports **AWS S3 and Hetzner Object Storage from day one**, built on ts-cloud's
`createObjectStorageClient()` - one SigV4 client already driving AWS, Backblaze B2, and Hetzner
(endpoint `{region}.your-objectstorage.com`, env `HETZNER_S3_*`). `config/cloud.ts` already
targets Hetzner for compute; storage follows.

The order below is deliberate: the WAL comes before read replicas because replicas need a truth
source to materialize from, and because a per-push bundle stream into any blob store is continuous
point-in-time backup - the single most requested ops feature - so the WAL pays for itself on one
box even if that instance never adds a second node. And the fail-open push philosophy in
`hooks.ts` (a push succeeds even when the app is down) inverts under WAL-before-ack, so the
inversion is explicit config, not a silent reversal.

## 18a - The seam, and the easy object-storage wins

No push-path changes in this sub-phase.

- [x] A `BlobStore` interface in `app/Actions/Git/blobs.ts`: `put` (streaming), `get` (streaming),
      `stat`, `delete`, `list`. `LocalBlobStore` rooted under `storage/` is the zero-config
      default; `S3BlobStore` rides ts-cloud's object-storage client with AWS and Hetzner both
      tested. All disk access stays inside `app/Actions/Git/`, per the standing rule.
      **Two things to know.** Key validation lives in the seam rather than per driver, because a
      driver that forgets is a driver with a traversal bug, and every key here can be built from
      something a request said. And S3 will not take a PUT without a length, so the S3 driver
      collects a stream before sending it and refuses past a ceiling with a message naming
      multipart - written down rather than hidden, because every current caller already has its
      bytes in memory and the day one genuinely streams a multi-gigabyte object, that error is the
      honest answer. "Both tested" is not yet true against live buckets: the driver is tested
      against a fake client (key mapping, prefixing, binary round trip, the ceiling), and AWS and
      Hetzner need credentials this machine does not have.
- [x] Workflow artifacts through the store: upload and download actions, `ExpireArtifactsJob`,
      and a `blob_key` column on `WorkflowArtifact`. The four readers - a runner fetching a
      previous job's output, a person downloading one, a set being tarred, an image rendered
      inline in a log - go through one `openArtifact` / `readArtifactBytes` pair, so they cannot
      disagree about the precedence between the recorded key and the derived one.

      **The local store is rooted at `storage`, not `storage/blobs`**, and that is what makes this
      a seam rather than a migration: a key of `artifacts/aa/bb/<digest>` resolves to exactly the
      path artifacts have always used, so an instance adopts the store and finds every existing
      file where it was. Getting this wrong was caught by an existing expiry test, and the failure
      mode it would have shipped is every artifact on disk reading as missing on upgrade day.
- [x] LFS through the store: `app/Actions/Git/lfs.ts` currently hard-wires ts-git-lfs's local
      object store; adapt it over `BlobStore`, upstream a custom-store seam in ts-git-lfs if it
      lacks one. **It lacked one, so it was built.** Every route in that library went through its
      `ObjectStore` interface except the download, which opened `Bun.file(objects.pathFor(oid))`
      itself - so a bucket-backed store satisfied every other route and 404'd on the bytes, the
      one operation that matters. ts-git-lfs 0.1.3 types the option as `ObjectStoreLike`, makes
      `pathFor` optional, and asks the store to stream; it ships with a test that serves objects
      from a store holding them in a `Map` with no path anywhere.

      The adapter here keeps the library's own key layout, so an instance with LFS objects
      already on disk finds every one where it left them. Its `write` calls the library's
      `verifyObject` before storing: an LFS object is addressed by the hash of its content, and
      an adapter that writes whatever it is handed under whatever name it is given removes that
      check for the whole feature. The first version did exactly that, and the existing "bytes
      that do not hash to the id in the URL are refused" test caught it - a 200 where a 422
      belonged.
- [x] Release assets and attachments through the store. Both already used a two-level fan-out
      under `storage/<feature>`, so their keys are the same paths minus the root the store
      supplies - nothing on disk moves.

      `release_assets.storage_path` is the one column that had to learn two shapes: every row
      written so far holds a full relative path and new ones hold a store key, so `assetKeyFrom`
      accepts both. A column meaning two things is exactly where each reader inventing its own
      guess produces a feature that works for new rows and 404s for old ones.
- [x] The repo-store seam in `app/Actions/Git/storage.ts`, behavior-neutral for now:
      `ensureLocal(owner, name)` as a thin wrapper over `repositoryPath()`, adopted by the git
      routes, ssh, and `write.ts`. This is the hook 18c grows teeth on. Async from the first
      commit on purpose - materializing cannot be synchronous, and a seam that changes shape when
      it grows teeth is a seam every caller has to be revisited for. It checks for `HEAD` rather
      than the directory, because a directory holding no repository is what an interrupted clone
      leaves behind, which phase 16 had to fix in the mirror import.

## 18b - The push WAL, sold as backup

Every push becomes a WAL entry: a database row carrying the ref transaction (old and new sha per
ref, monotonic per-repo sequence) plus a `git bundle` of the new objects persisted to the blob
store. The pre-receive hook already forwards the quarantine environment (built for secret
scanning), and `git bundle create` against the quarantine produces a self-contained, self-verifying
incremental pack. Ref deletions and pure ref moves carry no bundle: the row is the truth, the blob
is payload.

- [x] The `git_wal` model and migration: repo, sequence, ref updates, nullable blob key, status
      (pending, committed, void), actor, timestamps. `updates` and `reason` are `text`: three refs
      of ref-name-plus-two-shas already overflow the default varchar, and a truncated ref
      transaction replays into the wrong repository state.
- [x] `app/Actions/Git/wal.ts`: `recordPush` (bundle from quarantine, blob put, pending row),
      `commitPush`, `replay`, `verify` (via `git bundle verify`). The bundle streams from git
      straight into the store and is never held in the process. Tested against real git: the
      bundle verifies, restores into an empty repository, and a file that is not a bundle fails
      verification rather than passing quietly.
- [x] Ack ordering in the hook endpoints: WAL recorded before pre-receive answers, committed at
      post-receive. Config in `config/git-wal.ts` (not `config/git.ts`, which is the framework's
      commit-convention config with a type that does not describe this): `off`, `advisory`,
      `required` - `advisory` for a release before `required` becomes the recommendation, because
      this inverts the documented fail-open philosophy and existing installs get to choose when.
      The recording sits inside the gate's `allow()` closure so every path that lets a push
      through records it and none added later can forget.
- [x] A reconciler job sweeping pending rows against actual repository refs, committing or
      voiding. The rule is pure and tested (`walReconcile.ts`): a ref that moved on but whose
      objects are present counts as landed, because every entry but the newest has been built on -
      a rule demanding an exact tip match would void almost the whole log. A mixed verdict across
      one push stays pending for a person rather than being resolved automatically.
- [x] `buddy git:restore <owner>/<repo> [--at <seq|time>]`: latest checkpoint bundle plus WAL
      suffix replayed into a fresh bare repository. This is the backup feature and the
      materialization proof in one command, and it ships before any multi-node work does. It
      never writes over an existing repository - the operator moves the result into place - and
      `--verify` checks every bundle before using it.
- [x] **The live-push proof** (`tests/e2e/git-wal-push.test.ts`): a real `git push` through the
      real hooks, producing a row whose bundle verifies and restores into an empty repository.

      **It found two bugs that every fixture test around it had missed**, and both are the shape
      this codebase keeps naming. `git bundle create` refuses a bare sha - a bundle records
      *references*, and at pre-receive the refs still point at their old values - so the push
      path wrote a seventeen-byte header with no pack, reported success, and restored nothing;
      the unit test that "covered" bundling used `--all`, proving git works rather than that
      these arguments do. And the child's `close` listener was attached *after* its stdout was
      consumed, which races the event: the gate hung, pre-receive timed out, the push was allowed
      by the fail-open rule, and the log stayed empty while the push looked perfect.

      Three mistakes in *the test itself* are worth recording too, because each also looked
      exactly like the feature being broken: `installHooks` takes the hooks *directory* and needs
      `useSharedHooks` beside it; a hook secret under sixteen characters makes `hookSecret()`
      answer null, so the gate 404s at its own hook; and a bare `import` of a route file does not
      register its POST routes - only `route.importRoutes()` does, and the symptom is a 405
      naming GET and HEAD on a path that plainly has a POST.

      **And one that was not a test failure at all.** The first version of the cleanup removed
      `resolve(diskPath, '..')`, which on the setup-failure path - where `diskPath` is still the
      empty string - resolves to the *parent of the working directory*. It deleted this checkout
      and every sibling project beside it. Recovered from the remote; the uncommitted work in the
      tree at that moment was not. Test cleanup now goes through a guard that refuses any path
      that is empty, relative, walked upwards, or outside a root the test created, and the rule
      for anything written here from now on is: **delete only what you made, by the name you made
      it with, never by walking up from something else.**
- [x] The checkpoint job: periodically `git repack` locally, write a full `git bundle create
      --all` checkpoint to the blob store, prune the WAL prefix per retention config. Compaction
      runs on the primary only, per the reference architecture: replicas trade bandwidth for CPU.

      The sequence lives in the key (`wal/<repo>/checkpoints/<sequence>.bundle`, zero-padded)
      rather than in a table, because what a restore needs is "the newest checkpoint and what it
      covers" and both are in that name - a table would be a second thing to keep in step with
      the store, and the two disagreeing is a restore that silently starts from the wrong place.
      `buddy git:restore` uses it, so a restore is proportional to the repository rather than to
      its whole push history.

      **The pruning rules are pure and tested separately**, because they delete backup material:
      nothing past the checkpoint (those bundles are the only copy), nothing inside the retention
      window, and never a `pending` entry - that one is a question the reconciler has not answered
      yet, and deleting it turns it into a gap nobody can explain. Nightly rather than hourly, and
      it does nothing at all when the log is off.

## 18c - Refs in the database, repositories become cattle

Written to wait for phase 17's single-node MySQL, and built without it - because what it actually
needed turned out to be available on both engines. The dependency was on a per-repo `GET_LOCK`
for all-or-nothing across the refs of one push; what the ledger needs to be *correct* is a
compare-and-swap, and a conditional `UPDATE ... WHERE sha = :before` is atomic on its own
everywhere. Phase 17's lock upgrades this from per-ref CAS to per-push atomicity when it lands,
and nothing here changes for it.

The linearization point is the one the write-ahead log already had: the unique
`(repository_id, sequence)`. Whoever wins that insert owns the right to apply its ref
transaction. **No Postgres advisory locks anywhere**, per phase 17's design, and no multi-statement
transaction either - this codebase's query builder exposes none.

After this sub-phase, disk is a cache and the database plus blob store are the truth.

- [x] The `git_refs` ledger, updated by CAS in the same transaction as the WAL row, under the
      per-repo lock. `update-ref` on disk follows the ledger, never leads it. Applied in the gate,
      immediately after the sequence is won, so the log and the ledger move together. A conflict
      is reported and never forced: a ref that moved underneath means git will refuse the push a
      moment later for the same reason. The ledger never *blocks* a push, because the WAL row is
      the truth and an index that could veto the thing it indexes is an index with too much
      authority.

      `sequence` on each row is the entry that last moved it, which answers materialization's
      real question - what does this node still need - without reading the log at all. Rows
      seeded from disk land at sequence zero, deliberately visible: it means the ledger was
      believed rather than derived.
- [x] `ensureLocal` grows teeth: a missing or ledger-divergent repository is materialized from
      checkpoint plus WAL suffix before serving. Deliberately narrow on the serving path - only
      the *absent* case materializes inside a request, because a clone that silently waits on a
      multi-gigabyte fetch is worse than one that serves refs a few seconds old. A
      present-but-stale repository is the drift audit's business.

      Materializing never destroys: it creates what is absent and tops up what is behind, and
      removes nothing. The refs come from the ledger rather than from the bundles, because a
      bundle carries whatever names its objects travelled under - including the
      `refs/reviewos-wal/*` the log parks tips beneath - and where a ref *belongs* is the
      ledger's answer.
- [x] A drift-audit job sampling repositories, `for-each-ref` against the ledger, alerting on
      divergence rather than silently repairing it. **Reporting rather than repairing is the
      design**: every cause of drift worth knowing about is a bug, and a job that quietly
      reconciled would erase the evidence and let it recur. Sampled on a rotation keyed to the
      hour, so systemic drift is found quickly and a single stale repository eventually - an
      exhaustive `for-each-ref` across ten thousand repositories is an hour of git to answer a
      question that is almost always "no". A repository with no ledger rows is not drift, it
      predates the table, and is seeded once from disk.
- [x] Server-side writes (`app/Actions/Git/write.ts`, merges, reverts) go through the same CAS
      path as pushes. They never touch the pre-receive gate, so without this every merge would
      register as drift - and worse, a node materializing from the ledger would rebuild the
      repository as it was *before* the merge. Best-effort and after git's own guarded
      `update-ref`, so the ledger can never be the reason a merge fails; a failure here is drift
      the audit reports.
## 18d - The read path, sized for CI

Phase 15's runner fleet is the load: clone storms against hot repositories. The cheap answers come
before replicas, and the checkpoint bundle from 18b is most of them.

- [x] `bundle-uri` advertisement: `uploadpack.bundleURI` on the bare repository pointing at the
      checkpoint bundle's blob-store URL (signed, or fronted by a CDN). The bulk of a clone comes
      from static storage; the server only tops up. Written as git's actual keys
      (`uploadpack.advertiseBundleURIs`, `bundle.version`, `bundle.mode=all`,
      `bundle.checkpoint.uri`) into the repository's own config by the checkpoint job, so it is
      git advertising it rather than this application intercepting anything - and a client that
      cannot fetch the bundle falls back to an ordinary clone on its own.

      The URI points at `/{owner}/{repository}/bundles/checkpoint`, authorized through the same
      `authorize` the wire protocol uses: a checkpoint is the whole repository in one file, so
      serving it more freely than `upload-pack` would make every private repository readable by
      anybody who guessed the URL. Fronting that URL with a CDN, or pointing it straight at a
      signed bucket URL, is the next step for an instance that wants it and changes nothing here.
- [x] A pack cache for hot clone shapes, keyed on repository and want/have set. **Only the shape
      that is safe to cache**: a `want`-only request with no `have`, `shallow`, `deepen` or
      `filter` asks for "everything reachable from these tips", so its answer depends on nothing
      but those tips. That is a fresh clone, which is exactly what a fleet produces.

      Everything else falls through to git untouched, and so does anything the pkt-line parser
      does not completely understand - the parser fails open in exactly one direction, so no
      input can make this serve the wrong pack; the worst it can do is fail to save work. That
      matters more here than anywhere: this is the wire protocol, where the worst bug this
      project ever shipped lived, and a cache that returns a plausible-but-wrong pack is that
      same bug with a new cause.

      Capabilities are deliberately outside the key: they change the encoding rather than which
      objects are sent, and keying on them would miss for every client version. The e2e test
      clones twice and asserts the second clone's *content* rather than only the header.
- [x] Archives served from the blob store for CI that needs a tree, not history. Keyed on commit
      and format, which makes it a cache with no invalidation: an archive of a commit cannot
      change, because a commit cannot. A ref is deliberately not part of the key - two branches
      at the same commit are the same bytes. The response is `tee`'d, so the client is never
      waiting on the cache write, and a failed write just means the next request misses.
- [x] Runner-side guidance in phase 15's docs: reference clones and bundle bootstraps before
      hitting the forge. In `docs/runner-protocol.md`, in the order worth trying them - let the
      client use the advertised checkpoint bundle (nothing needed on the runner, git 2.46+ does
      it by default), keep a reference clone, ask for less with a shallow single-branch clone,
      and take an archive when history is not wanted at all. It also names the two things not to
      do: disabling gc on a runner's caches, and pointing many runners at one shared checkout,
      which turns a clone storm into a lock convoy.
- [x] Only after those are measured insufficient: stateless read replicas - a node running
      `upload-pack` and `ensureLocal`, placed by rendezvous hashing at the proxy, consistency
      checked against the ledger per request (a cheap indexed read; no gossip at this scale).
      Replica boxes are provisioned by ts-cloud and run pantry-managed services, per phase 16's
      infra stance - no container orchestration layer.

      **Measured, and they are not needed yet - so they are not built.** The box's own condition
      is the deliverable, and here is what it measures to.

      On this machine, a 250-commit repository producing a 58 KB pack: a cold `upload-pack`
      serving a fresh clone takes a median of **20 ms**, and the same clone from the pack cache
      takes **under a millisecond** - the git work disappears entirely rather than getting
      faster. With phase 16's `heavy` class at eight concurrent transfers, a single box therefore
      absorbs roughly **400 cold clones a second**, and effectively unbounded cached ones,
      because a cache hit is a read from the blob store and nothing else.

      Phase 15's fleets are tens of runners starting jobs over seconds. The gap between that and
      four hundred a second is three orders of magnitude, and the checkpoint bundle removes even
      the cold case for any client that speaks `bundle-uri`. **A replica would add a node, a
      placement rule, and a per-request consistency check to solve a problem this instance does
      not have.**

      What would change the answer, so the next person can check rather than re-derive: a
      repository large enough that a cold pack takes seconds rather than milliseconds (the cost
      is in the object walk, so it scales with history and file count, not with clone rate), or
      a sustained clone rate that keeps all eight `heavy` slots busy - which shows up as 503s
      with `Retry-After` on the wire-protocol routes rather than as slowness, and is therefore
      visible without instrumenting anything. Either of those, and this box reopens with a number
      behind it.

## 18e - Research only, not scheduled

Notes, not plans. Each of these asks whether something needs building; two of the answers are
"probably not yet", and writing that down is the deliverable.

- [x] **Multi-node writes: receive-pack on any node under the per-repo lock plus WAL likely works
      with no new machinery.** The design note, now that the WAL exists:

      The pieces are already in place. A push is refused or allowed by the gate, which is an HTTP
      call to the control plane rather than anything local; the WAL row is allocated a sequence
      under a unique index that a second node cannot duplicate; and the bundle goes to a blob
      store every node can read. What a second write node adds is the ordering question the
      per-repo lock answers, and phase 17 brings that lock (`GET_LOCK` on MySQL) for the ref
      ledger anyway.

      So the shape is: take the per-repo lock in the gate, allocate the sequence and write the
      pending row inside it, release, let git write its objects locally, and let the reconciler
      settle what the hook did not confirm. A node that dies mid-push leaves a pending row and
      local objects nobody references, which is the state the reconciler already handles.

      **What actually stops this today is not writes, it is reads.** A push that lands on node B
      is invisible to node A until A materializes it, and `ensureLocal` does not have teeth until
      18c. Multi-node writes are therefore blocked on 18c rather than on anything in this note,
      and 18c is blocked on phase 17. Nothing here needs code before then.

- [x] **SSH on non-primary nodes.** Answered by the same dependency, and one detail worth
      recording separately: the SSH transport carries no HTTP request, so a node serving it needs
      the actor identity from the key alone (`REVIEWOS_ACTOR_ID`, which `ssh.ts` already forwards
      to the hook) and needs the deploy-key and user-key tables the control plane owns. Both are
      ordinary database reads, so an SSH node is a read replica plus a hook endpoint rather than
      a new kind of node. No new machinery, and no reason to build it before there is a second
      node at all.

- [x] **Whether gossip or placement hints ever matter below ten thousand repositories. The
      answer is no**, and now with a number behind it. Placement by rendezvous hashing at the
      proxy needs no coordination: every node computes the same answer from the repository name
      and the node list, and the node list changes when an operator changes it rather than
      continuously. Consistency is checked per request against the ref ledger, which is one
      indexed read - at ten thousand repositories and a hundred requests a second that is noise
      next to the git work each request is about to do.

      Gossip buys agreement about *state* that no part of this design needs: the database is the
      linearizer, and a node that disagrees with it is wrong rather than differently informed.
      The point at which this stops being true is when the ledger read itself is the bottleneck,
      which is a database problem with database answers (phase 17's Vitess), not a distributed
      systems problem with a gossip answer.

## Deliberately not building

Named so they stop being re-proposed, same as the [index](./index.md) list:

- **No consensus system, no leader election.** The reference architecture's core lesson: the
  database CAS is the only coordination, and any node can be primary.
- **No git reimplementation and no git library dependency.** The stock binary and ordinary bare
  repositories, same as `storage.ts` already insists.
- **No shared-disk multi-node** (NFS, Ceph). The WAL exists precisely so nodes never share a
  filesystem.
- **No mandatory object storage or Redis for single-node installs.** Local disk is a driver, not a
  fallback.
- **No stored diffs.** Diffs stay computed from git per request; phase 14 already proved the
  streaming path is cheap enough, and a diff cache is an invalidation bug factory the design note
  in `DiffRowsAction` argues against.
