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

Waits for phase 17's single-node MySQL. After this sub-phase, disk is a cache and the database plus
blob store are the truth.

- [ ] The `git_refs` ledger, updated by CAS in the same transaction as the WAL row, under the
      per-repo lock. `update-ref` on disk follows the ledger, never leads it.
- [ ] `ensureLocal` grows teeth: a missing or ledger-divergent repository is materialized from
      checkpoint plus WAL suffix before serving.
- [ ] A drift-audit job sampling repositories, `for-each-ref` against the ledger, alerting on
      divergence rather than silently repairing it.
- [ ] Server-side writes (`app/Actions/Git/write.ts`, merges, reverts) go through the same CAS
      path as pushes.

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
- [ ] A pack cache for hot clone shapes, keyed on repository and want/have set.
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
- [ ] Only after those are measured insufficient: stateless read replicas - a node running
      `upload-pack` and `ensureLocal`, placed by rendezvous hashing at the proxy, consistency
      checked against the ledger per request (a cheap indexed read; no gossip at this scale).
      Replica boxes are provisioned by ts-cloud and run pantry-managed services, per phase 16's
      infra stance - no container orchestration layer.

## 18e - Research only, not scheduled

- [ ] Multi-node writes: receive-pack on any node under the per-repo lock plus WAL likely works
      with no new machinery; needs a design note before it needs code.
- [ ] SSH on non-primary nodes.
- [ ] Whether gossip or placement hints ever matter below ten thousand repositories. Expected
      answer: no.

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
