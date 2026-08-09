# Security

## Reporting a vulnerability

Email **security@reviewos.org**. Please do not open a public issue for something
exploitable - a forge's issue tracker is the worst possible place to publish a
way into the instances running it.

If you would rather use GitHub's private reporting, the advisory form on the
repository reaches the same people.

Include whatever you have. What helps most, roughly in order:

- what an attacker gets, in a sentence
- the steps to reproduce it, or a request that demonstrates it
- the version or commit you tested against
- whether you have told anybody else

You do not need a proof of concept, a CVSS score, or a suggested fix. A clear
description of the wrong behaviour is worth more than a polished report that
takes a week to write.

## What to expect

- **An acknowledgement within three working days.** If you do not hear back,
  assume the mail went astray rather than that it was ignored, and try again.
- **An assessment within a week**, saying whether it is a vulnerability, how
  serious, and roughly when a fix will land.
- **Credit in the advisory**, under whatever name you give, unless you would
  rather not be named.

There is no bounty. This is an open source project run by a small number of
people, and promising money would be a promise we could not keep reliably.

## Disclosure

Coordinated. A fix ships, instances get a reasonable window to upgrade, and then
the advisory is published with the details. What "reasonable" means depends on
how bad it is and whether it is being exploited - the point is that the people
running instances find out from a release note rather than from a stranger.

If you have a deadline of your own, say so in the first email. It is far easier
to plan around a date than to discover one.

## What is in scope

Anything that lets somebody read, write or delete what they should not, in this
repository's code:

- reading a private repository, issue, pull request or review
- acting as another account, or beyond what a token was granted
- escaping a repository's storage path, or reaching the host through git
- a token, session or key that outlives what it should
- server-side request forgery through webhooks, mirrors, or avatar fetching
- anything that lets a pushed file execute on the server

Denial of service through sheer volume is generally **not** in scope: the answer
to it is capacity and rate limits, both of which are documented and tunable. An
amplification - one small request costing the server a great deal - **is**, and
is worth reporting.

## What is not

- vulnerabilities in a dependency, unless this project uses it in a way that
  makes it exploitable here. Report those upstream; tell us if we need to pin.
- missing hardening headers, or a TLS configuration, on somebody's instance.
  Those are deployment choices, and the [self-hosting
  guide](docs/self-hosting.md) is where to argue they should be different.
- an instance somebody is running badly. If you find a public instance with an
  obvious misconfiguration, tell its operator.
- output from a scanner with no explanation of what it means here.

## For people running an instance

The [self-hosting guide](docs/self-hosting.md) covers the operational half. The
three that matter most:

- **Terminate TLS.** Tokens and session cookies cross the network on every
  request, and `buddy instance:check` warns when `APP_URL` says otherwise.
- **Keep `APP_KEY` secret and stable.** Everything signed and encrypted depends
  on it. Rotating it invalidates every session; leaking it is worse than leaking
  a password.
- **Back up Postgres and `storage/repos` from the same moment**, and test the
  restore. An untested restore procedure is a hope.
