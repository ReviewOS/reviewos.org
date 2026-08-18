# Identity tokens

A job can ask this instance for a short-lived token that says who it is, and
present that to a cloud instead of a stored access key.

The problem it removes: a deploy job needs to prove its identity, and the
obvious answer - a long-lived key in a secret - is a credential that lives
forever, works from anywhere, and is one leaked log away from being somebody
else's. A token minted here lasts fifteen minutes, names exactly which
repository and which ref asked for it, and is verifiable by anybody who can
fetch this instance's public key.

## Asking for one

```yaml
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: |
          aws sts assume-role-with-web-identity \
            --role-arn "$ROLE" \
            --role-session-name reviewos \
            --web-identity-token "$(reviewos-oidc sts.amazonaws.com)"
```

`reviewos-oidc [audience]` is on the PATH in every job. The audience is whatever
the other side insists on - `sts.amazonaws.com` for AWS - and defaults to this
instance's own URL, because a token with no audience is one any service could be
persuaded to accept.

The endpoint underneath is `POST /api/runner/oidc`, authenticated with the job
credential.

## What the token says

The claim names are GitHub's, deliberately: a cloud trust policy is a document
somebody writes once and forgets, and the ones people already have are written
against these names. Inventing better ones would mean everybody rewriting a
policy to gain nothing.

| Claim | Means |
|---|---|
| `sub` | `repo:owner/name:ref:refs/heads/main`, or `:environment:production`, or `:pull_request` |
| `repository`, `repository_owner`, `repository_visibility` | Which repository, whose, and whether it is public |
| `run_id`, `run_number`, `run_attempt` | Which run, and which attempt of it |
| `workflow`, `workflow_ref`, `job_workflow_ref` | Which file, at which ref |
| `ref`, `ref_type`, `sha` | What was being built |
| `event_name`, `actor` | What started it and who |
| `environment` | The deployment environment, when the job named one |
| `runner_environment` | `self-hosted` |

**Every one of them comes from the run, not from the request.** The only thing a
caller chooses is the audience. A token whose `repository` came from the body
would be a token any job could mint for any repository, which is the thing this
replaces.

An environment makes the subject more specific, which is what somebody means by
"only the production deploy may assume this role":

```
repo:acme/api:environment:production
```

## Verifying one

Two documents, at the root and public:

```
GET /.well-known/openid-configuration
GET /.well-known/jwks.json
```

The path is fixed by the specification and by every implementation of it, which
is why they are not under `/api`: a document AWS will never ask for is a document
that does not exist. Both are uncredentialed, because whoever is checking a
signature has no account here - and neither contains a secret, since a public key
is a thing you publish.

Registering this instance with a cloud is the ordinary flow: give it the issuer
(`https://your-instance`), and it fetches the rest.

## Rotation

`instance_keys` holds the signing keys. A rotation generates a new key that
signs from that moment, and **the old one keeps verifying**: a token signed a
minute before still has fourteen minutes to live, and a JWKS holding only the
newest key would make those unverifiable - which is a rotation that takes an
outage with it, and therefore a rotation nobody performs.

Every token carries the `kid` of the key that signed it, so a verifier picks the
right one without guessing.

The private halves are encrypted with `APP_KEY`, like workflow secrets, and for
a stronger reason: this key signs statements a cloud provider will act on. A
database backup that leaks it is somebody able to mint a token for any
repository here.

## What a fork gets

Nothing. By [the threat model](./ci-threat-model.md) an untrusted run receives no
credentials, and "I am acme/api on main" is the strongest credential this
instance can issue. The refusal says so rather than answering with an empty
token, which would fail later and somewhere else.
