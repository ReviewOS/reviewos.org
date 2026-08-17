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
- **A value this instance can no longer decrypt is skipped**, not delivered
  empty. A job handed an empty credential authenticates as nobody and fails
  somewhere far from the cause; a missing one fails at the line that uses it.

## Rotating `APP_KEY`

Every secret is sealed with it, so changing it makes all of them undecryptable -
they are skipped, and jobs fail at the line that needs them. Set them again
after a rotation. There is no re-encrypt command yet, and pretending otherwise
would be worse than saying so.
