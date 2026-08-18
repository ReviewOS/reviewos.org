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

## Four scopes, narrowest wins

| Scope | Reaches |
|---|---|
| `environment` | only a job deploying there, only after its gate opened |
| `repository` | every job in this repository |
| `owner` | every repository that owner has |
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
