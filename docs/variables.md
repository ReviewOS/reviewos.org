# Variables

Values a workflow reads as `${{ vars.NAME }}`, set at four levels:

| Level | Set where | Beats |
|---|---|---|
| workflow | `env:` in the workflow file | everything |
| repository | Settings → Variables | the owner and the instance |
| owner | the owner's variables | the instance |
| instance | an administrator | nothing |

**Narrowest wins.** That is the rule everybody expects, and it is not the
interesting part. The interesting part is that a value can be wrong at a level
nobody is looking at - so every listing says which level answered and what it
overrode:

```
REGISTRY = ghcr.io/repository
set at the repository level, by widgets
overriding owner (acme): ghcr.io/owner · instance (this instance): docker.io
```

"It is `us-east-1`" is not the answer somebody needs when a deploy went to the
wrong region. "It is `us-east-1`, set by the organization, and this
repository's `eu-west-1` is underneath it" ends the conversation.

## Setting one

```sh
curl -sX POST https://reviewos.example/api/repos/variables \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","operation":"set",
       "scope":"repository","key":"REGISTRY","value":"ghcr.io/acme/widgets"}'
```

`scope` is `repository`, `owner`, or `instance`. The workflow level has no row:
it is `env:` in the file, and it lives where it is read - a value written beside
the job it applies to is the most specific statement anybody made about it.

Setting a value that something narrower already overrides says so in the answer,
because otherwise it looks like it worked and the question comes back three days
later:

```json
{ "note": "Runs still see `ghcr.io/acme/widgets`, set at the repository level." }
```

An instance variable needs an instance administrator, and an owner variable
needs the owner - administering *one* repository is not permission to change
every repository an organization has.

## These are not secrets

They are readable by anybody who can read the repository, they appear in logs,
and they are handed to every job **including one from a fork**.

There is no secret store here yet. That is stated rather than approximated with
a `secret: true` flag on a plain-text table, which is a thing somebody
eventually forgets to check.
