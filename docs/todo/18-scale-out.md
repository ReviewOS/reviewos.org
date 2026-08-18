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

- [ ] A `BlobStore` interface in `app/Actions/Git/blobs.ts`: `put` (streaming), `get` (streaming),
      `stat`, `delete`, `list`. `LocalBlobStore` rooted under `storage/` is the zero-config
      default; `S3BlobStore` rides ts-cloud's object-storage client with AWS and Hetzner both
      tested. All disk access stays inside `app/Actions/Git/`, per the standing rule.
- [ ] Workflow artifacts through the store: upload and download actions, `ExpireArtifactsJob`,
      and a `blob_key` column on `WorkflowArtifact`.
- [ ] LFS through the store: `app/Actions/Git/lfs.ts` currently hard-wires ts-git-lfs's local
      object store; adapt it over `BlobStore`, upstream a custom-store seam in ts-git-lfs if it
      lacks one.
- [ ] Release assets and attachments through the store.
- [ ] The repo-store seam in `app/Actions/Git/storage.ts`, behavior-neutral for now:
      `ensureLocal(owner, name)` as a thin wrapper over `repositoryPath()`, adopted by the git
      routes, ssh, and `write.ts`. This is the hook 18c grows teeth on.

## 18b - The push WAL, sold as backup

Every push becomes a WAL entry: a database row carrying the ref transaction (old and new sha per
ref, monotonic per-repo sequence) plus a `git bundle` of the new objects persisted to the blob
store. The pre-receive hook already forwards the quarantine environment (built for secret
scanning), and `git bundle create` against the quarantine produces a self-contained, self-verifying
incremental pack. Ref deletions and pure ref moves carry no bundle: the row is the truth, the blob
is payload.

- [ ] The `git_wal` model and migration: repo, sequence, ref updates, nullable blob key, status
      (pending, committed, void), actor, timestamps.
- [ ] `app/Actions/Git/wal.ts`: `recordPush` (bundle from quarantine, blob put, pending row),
      `commitPush`, `replay`, `verify` (via `git bundle verify`).
- [ ] Ack ordering in the hook endpoints: WAL recorded before pre-receive answers, committed at
      post-receive. Config `git.wal` in `config/git.ts`: `off`, `advisory`, `required` -
      `advisory` for a release before `required` becomes the recommendation, because this inverts
      the documented fail-open philosophy and existing installs get to choose when.
- [ ] A reconciler job sweeping pending rows against actual repository refs, committing or
      voiding.
- [ ] `buddy git:restore <owner>/<repo> [--at <seq|time>]`: latest checkpoint bundle plus WAL
      suffix replayed into a fresh bare repository. This is the backup feature and the
      materialization proof in one command, and it ships before any multi-node work does.
- [ ] The checkpoint job: periodically `git repack` locally, write a full `git bundle create
      --all` checkpoint to the blob store, prune the WAL prefix per retention config. Compaction
      runs on the primary only, per the reference architecture: replicas trade bandwidth for CPU.

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

- [ ] `bundle-uri` advertisement: `uploadpack.bundleURI` on the bare repository pointing at the
      checkpoint bundle's blob-store URL (signed, or fronted by a CDN). The bulk of a clone comes
      from static storage; the server only tops up.
- [ ] A pack cache for hot clone shapes, keyed on repository and want/have set.
- [ ] Archives served from the blob store for CI that needs a tree, not history.
- [ ] Runner-side guidance in phase 15's docs: reference clones and bundle bootstraps before
      hitting the forge.
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
