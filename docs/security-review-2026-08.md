# Security review, August 2026

A review of the surfaces added in the phase 13, 17 and 06 work - write-through review, the shard
key, and instance-wide code search - plus a pass over the credential and process boundaries those
touch. It is a written record rather than a checklist: the point is what was looked at, what was
found, and what was decided not to be a problem and why.

The CI boundary is out of scope here and has its own document, [the CI threat
model](./ci-threat-model.md), because the attacker there is somebody who can open a pull request and
the asset is the host running their code. This one is about credentials, scope, and the cost a
stranger can impose.

## What was found, and fixed

**A credential feature with no door into it.** Write-through review was built, tested and ticked, and
nothing wrote `forge_credentials` - so `credentialFor` always answered null and every review stayed
local. Not exploitable; worse than that, it was a claim in the roadmap that the code did not support.
Fixed by building the connect path (`POST /api/user/forge-credentials`), which is also where the
next two findings live.

**The API base could not be allowed to come from the request.** Connecting a credential spends the
token once against the forge to read back who it belongs to. If the caller named that URL, they
could have this instance post a token to a server of their choosing - a credential exfiltration
primitive dressed as a convenience. The base is derived from the host, and the host is constrained
to a bare name so it cannot carry a path or a port that moves where the request lands.

**Instance-wide search was unthrottled.** One request starts a git process per repository that
survives the index. That makes it the cheapest way to ask this instance to do a lot of work: no
repository needed, no push, no size, no clone. Now `throttle:20,1m`, which is generous for a person
searching and useless for somebody grinding the box.

**The viewer was read from the wrong place.** `request.user` is not populated on that path, so
instance-wide search ran as anonymous for everybody. It failed *closed* - a signed-in reader saw
only public repositories rather than seeing somebody else's - so this was a correctness bug rather
than a disclosure, but a search that cannot find your own private code is a search nobody trusts.

## What was checked and found sound

**A token only goes to the host it was issued for.** The exfiltration path worth worrying about is a
repository admin editing a mirror's remote URL to point at a server they control, and waiting for a
reviewer's token to follow it. It cannot: `credentialFor` is keyed by host, so a mirror pointed
somewhere else finds no credential and sends nothing. The host derivation is the load-bearing part,
so it is tested against the three shapes that fool a careless parser -
`https://github.com@evil.example/...` (userinfo), `https://github.com.evil.example/...` (suffix),
and `ssh://git@evil.example/...` (which must not be read as the scp form).

**No instance-wide credential can write on somebody's behalf.** Asserted as an absence rather than a
behaviour: the module that posts a review may not name `mirrorToken`, `./credentials`,
`GITHUB_TOKEN` or `process.env`. Testing that a review without a credential stays local proves the
branch works today; this is what stops a convenient fallback being wired in next quarter, which is
how every review ends up looking like a bot wrote it.

**Search scope is decided before anything is searched.** Instance-wide search reuses
`readableRepositoryIds` rather than re-implementing "may this person read this repository". A second
answer to that question is a second answer that eventually disagrees. A repository the caller cannot
read is never searched, so it cannot contribute a match, so its existence cannot be inferred from
one - the same reason the per-repository endpoint answers 404 rather than 403.

**A filename git would read as an instruction.** `pathspecs()` drops anything beginning with `:`,
which is right for a path arriving from a query string and would be wrong for the index: a file
genuinely named `:weird.ts` would be silently excluded from its own repository's search. The
candidate list now gives up narrowing when it contains one of those or a glob character, so the
failure is a slower search rather than a hidden result.

**Every git invocation is an argument array.** No shell, and the pattern goes after `-e` and paths
after `--`, so a search for `--help` is a search rather than git's help and a search for `-P` does
not quietly change the regex engine. The one `/bin/sh -c` in the codebase is the CI runner executing
a workflow's own command, which is the CI threat model's subject and gated there.

**Secrets stay sealed on the way out.** The credential list selects the columns an interface needs -
host, login, last used, last error - and never `sealed`. A credential that cannot be decrypted is
treated as absent rather than as an error, so a rotated instance key degrades to "reconnect your
account" instead of a stack trace with a ciphertext in it.

## Noted, not fixed

**Secret resolution loads every row before filtering.** `app/Actions/Workflow/secrets.ts` reads all
of `workflow_secrets` and then decides which apply to the job in TypeScript. Nothing is decrypted
before the filter and no secret crosses a scope today, so this is not a disclosure - but the blast
radius of a mistake in that predicate is every secret on the instance rather than one scope's, and
the query should carry the scope. Worth doing before an instance is large enough for the read to
matter anyway.

**The index is a filter, and a stale one is a slow search.** Deliberate, and recorded here so it is
not mistaken for an oversight: a shard can be out of date without being wrong, because the paths
changed since it was built join the candidate set and an unreachable base commit sends the search to
the whole repository. There is no path by which a stale index hides a result.

## Review status

Written 19 August 2026, covering the work committed that day. Not a substitute for a review by
somebody who did not write the code - every finding above is in code I wrote, which is exactly the
review a second person should not have to repeat.
