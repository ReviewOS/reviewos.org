# Secrets

Credentials a job can read, encrypted with this instance's `APP_KEY` and
delivered to one job at a time.

```sh
curl -sX POST https://reviewos.example/api/repos/secrets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"set",
       "scope":"environment","environment":"production",
       "key":"DEPLOY_TOKEN","value":"…"}'
```

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./deploy
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

## There is no way to read one back

`operation: "list"` returns names, scopes, and when each was last set. No
endpoint returns a value, and no page renders one.

A reveal button is the feature that turns one compromised session into every
credential an organization has. Not having it costs somebody a trip to their
password manager on the day they need the value back; that is the trade, and it
is made on purpose.

## Five scopes, narrowest wins

| Scope | Reaches |
|---|---|
| `environment` | only a job deploying there, only after its gate opened |
| `repository` | every job in this repository |
| `owner` | every repository that owner has |
| `pool` | any job a machine in that pool takes, whatever repository it is for |
| `instance` | every repository on the server |

**The environment scope is the one that earns the feature.** A deploy credential
attached to `production` is not reachable from the test job in the same run -
a separation a repository-wide secret cannot express however carefully somebody
names it. And it is withheld from the deploy job itself until the environment's
approval has happened: otherwise the credential sits in the job's environment
while it waits for a reviewer, which is the window somebody would use.

Setting an instance or owner secret takes more than repository administration:
administering *one* repository is not permission over every repository an
organization has.

## The recommended path: a secret this instance never held

An encrypted column answers "where do we keep it" and nothing at all about what
happens when the database is copied. So a secret may be a **reference** into the
store your platform already runs, read at the moment a job claims work and
forgotten afterwards:

```bash
curl -sX POST "$SERVER/api/repos/secrets" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"set","key":"PUBLISH_TOKEN",
       "reference":"store://prod/secret/data/publish#TOKEN"}'
```

The stores are configured by whoever runs the instance, in a JSON file named by
`REVIEWOS_SECRET_STORES`:

```json
{
  "mounted": { "kind": "file", "address": "/run/secrets" },
  "prod": { "kind": "vault", "address": "https://vault.internal", "tokenFile": "/run/secrets/vault-token" }
}
```

`file` is a directory your platform mounted - Docker secrets, a Kubernetes
volume - which most instances already have. `vault` is HashiCorp Vault KV
version 2, with the token read from a file per request so a rotated one is
picked up without a restart, and never from an environment variable that shows
up in `ps` and in crash reports.

**A reference names a store, never a URL.** `store://<store>/<path>#<field>` and
nothing else: the difference between "read this from the store you set up" and
"fetch this from an address a repository administrator typed" is that the second
is a request this server makes from inside your network on somebody else's
say-so. A path that climbs out of a file store is refused, before and after
normalising it.

**A reference that cannot be read fails the job by name.** The claim resolves
references, so a store that is down, a token that expired or a path that moved
stops the job before its first step with a sentence saying which secret and why.
The alternative is a job that starts with an empty credential and fails forty
minutes later against somebody else's API, with an error that says nothing about
this instance.

## A pool's secrets belong to the machines

A registry credential often exists because *these* runners are allowed to
publish, and that is not a fact about any repository. Writing it into every
repository that needs it is how one credential ends up in twenty places and is
rotated in three.

```bash
curl -X POST "$SERVER/api/instance/fleet" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"operation":"set-secret","pool":3,"key":"REGISTRY_TOKEN","value":"..."}'
```

It is set on the fleet rather than on a repository, so it takes `fleet` at
`admin` on the token and instance administration or maintaining that pool on the
person - the same permission as drawing the pool's boundary, because this is
drawing it. `list-secrets` gives names and when each was last written;
`unset-secret` removes one.

A job receives it because a machine in that pool took the job. A run on anybody
else's machines never sees it however its workflow asks, and neither does a
runner that belongs to no pool - which is what every installation had before
pools existed, and the safe direction: the credential exists because those
machines are trusted with it.

It does not appear in a repository's own listing, and cannot: which pool a job
will land on is not known until a machine claims it, so a repository page that
listed pool secrets would be listing credentials that may never arrive.

**A repository's own secret wins over a pool's.** A pool secret says where work
runs; a repository secret says what is running, and the second is the more
specific statement. An operator who needs a value nothing can override sets it
and says so, rather than relying on an ordering nobody can see.

A fork's run gets none of this either. The machines are exactly what an
untrusted run must not reach through, so the trust check happens before any
scope is considered.

## What a job gets

- **A fork's pull request gets none.** Checked at the claim, where the trust
  flag lives, rather than left to the runner. A fork's job runs; it runs with
  nothing.
- **Readable as `${{ secrets.NAME }}`, not injected into the environment.** A
  workflow that wants one in a variable says so with `env:`, so a step that was
  never told about a credential does not have it where a child process, a crash
  dump or a `printenv` would find it.
- **Masked in the log before the first step runs**, whether or not the workflow
  prints one. The way a credential reaches a log is never `echo $TOKEN` - it is
  a curl that fails and prints the request it tried. Masking happens on the
  runner, because masking after the value has crossed the wire is not masking.
- **And redacted again on the way into the database**, which is the second line.
  The first is somebody else's program: a runner that is old, patched or hostile
  is still one this instance accepts logs from, and "we asked it to mask" is not
  a property of the stored log. The value, its base64 form and its
  percent-encoded form are each replaced with a visible `[redacted]` - a silent
  gap reads as a bug in the log and sends somebody looking for it.

  Two limits, both deliberate. A value shorter than five characters is left
  alone: a secret of `dev` would blank a word everywhere it appears and turn
  every log on the instance into a puzzle. And **a value split across two writes
  survives this pass** - it sees one chunk at a time, and holding the tail of
  every chunk to check the join would mean buffering a log that is meant to be
  streamed. The runner's own masking covers that case, because it sees the
  stream. A redaction feature people believe is total is worse than one whose
  edge they know.
- **A value this instance can no longer decrypt is skipped**, not delivered
  empty. A job handed an empty credential authenticates as nobody and fails
  somewhere far from the cause; a missing one fails at the line that uses it.
- **Everything in scope, unless the job narrows it.** A job that says nothing
  receives every secret it could - Actions' behaviour, and what existing
  workflows expect. A job that names them receives those and no others:

  ```yaml
    test:
      runs-on: ubuntu-latest
      reviewos:
        secrets: []            # needs none
      steps: [{ run: bun test }]
  ```

  Worth doing on any job that runs code you did not write, which is most of
  them: a test job holding the deploy key for the length of its run is a
  credential a compromised dependency can read. `secrets: []` is a job saying it
  needs none, which is not the same as a job that said nothing. See
  [extensions](./extensions.md).

## Rotating `APP_KEY`

Every secret is sealed with it, so changing it makes all of them undecryptable -
they are skipped, and jobs fail at the line that needs them. Set them again
after a rotation. There is no re-encrypt command yet, and pretending otherwise
would be worse than saying so.

## The automatic token

Every job is handed one, as `${{ secrets.GITHUB_TOKEN }}` and `${{ github.token }}`:

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  comment:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sX POST "$GITHUB_API_URL/repos/pulls/comments" \
            -H "Authorization: Bearer $TOKEN" -d '…'
        env:
          TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**`permissions:` is what decides.** A workflow that says nothing gets a token
that can read the repository and nothing else - on every instance, forever.
Actions' own default depends on an organization setting, which is a footgun this
instance declines to reproduce. A job's `permissions:` replaces the workflow's
rather than adding to it, and a key this instance has no scope for (`packages:`,
`id-token:`) is reported rather than silently granting nothing.

**It reaches one repository.** The row is `selection: selected` with exactly one
repository attached: a job that can comment on the repository it is building
must not be able to comment on every repository its actor can reach.

**A fork's pull request gets read access whatever its workflow file declares.**
The workflow in a fork's branch is the fork's code, and it does not get to
decide what it may do to the repository it forked.

It is revoked when the job reports, and expires within the hour regardless -
the expiry is the backstop for a runner that dies without reporting, not the
mechanism.
