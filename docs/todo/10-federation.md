# 10 - Federation

Research, not a commitment. The question is whether an issue opened on one instance can be answered
from another, and whether a pull request can cross instances without either side losing track.

Do not start building until the decision below is written down here with reasons. Federation touched
early and half-heartedly is worse than no federation, because the data model bends around it.

**Decided, 19 August 2026: identity portability first, over AT Protocol.** The reasoning is below,
and the short version is that the two candidate goals are not equally valuable to this product, and
the two candidate protocols are not equally good at the one that is.

## The question

- [x] Write down what federation is actually for here. Two candidates, and they pull in different
      directions:
  - Identity portability: one account, usable across instances, so contributors do not register
    everywhere
  - Content federation: issues, pull requests, and reviews replicating across instances

      **They are not equal, and treating them as two halves of one feature is the mistake.**

      Identity portability solves a problem this product has today. A self-hosted forge's worst
      moment is the drive-by contribution: somebody finds a bug, and between them and a one-line
      fix is a registration form, an email confirmation and a password they will never use again.
      Every self-hosted instance pays that tax separately, and the contribution that does not happen
      leaves no trace, so the cost is invisible and enormous.

      Content federation solves a problem this product mostly does not have. An issue tracker that
      replicates across instances is a *second* source of truth for a conversation, and the moment
      the two disagree - an edit that did not propagate, a delete that did - somebody has to decide
      which instance is right. GitHub is not beaten by making a distributed copy of its issue
      tracker; it is beaten on the review surface, which is phase 14's problem and needs no
      protocol at all.

      So: identity first, content later or never. What follows evaluates the protocols against that
      ordering rather than against a generic "does it federate".
- [x] Decide which of those matters, or that neither does yet

      **Identity portability matters. Content federation does not, yet.** Recorded rather than left
      implied, because the data model bends differently for each: identity portability needs an
      account that can be *proved* to belong to somebody without this instance having issued it,
      and touches sign-in and attribution. Content federation needs every object to carry a stable
      cross-instance id, an inbox, a delivery queue and a conflict rule, and that is the shape that
      is expensive to add later and worse to add early.

## Options to evaluate

- [x] **ActivityPub with ForgeFed.** The specification exists, Forgejo has an implementation to
      learn from, and it fits the fediverse. Evaluate: how complete ForgeFed actually is, what
      Forgejo shipped versus what it planned, and how a pull request across instances behaves in
      practice rather than in the specification.

      **More complete on paper than anything else, and aimed at the goal we ranked second.**

      The specification is further along than its reputation suggests. The current text is a branch
      snapshot dated 18 June 2025 and still labelled under construction, but it defines the objects
      a forge actually has - `Repository`, `TicketTracker`, `PatchTracker`, `Ticket`, `Patch`,
      `Push`, plus `Project`, `Team` and `Organization` - and, notably for this product, it defines
      review threads anchored to code: a thread whose `target` is a `CodeQuote`, comments with
      suggestion attachments, resolve and unresolve, and binding versus non-binding verdicts. That
      is the hard part of the phase-4 model, and somebody has thought about it.

      The problem is not the specification. It is that ActivityPub federates *content*, and content
      is the half we decided we do not need. Adopting it would mean building inbox and outbox
      delivery, retry queues, signed request verification, instance blocking and spam defence -
      every one of them a subsystem with its own failure modes - to get a replicated issue tracker,
      while the drive-by contributor still has to register here.

      It also brings the moderation surface with it, and that surface is not optional: an open
      inbox is an open door, and every fediverse server operator will tell you what arrives through
      it. That is a permanent operational cost carried by every self-hoster of this software, for a
      feature they did not ask for.
- [x] **AT Protocol**, the approach Tangled takes. Evaluate: identity portability, whether the
      lexicon fits a forge's objects, what a PDS costs to run, and how much of this depends on
      infrastructure outside our control.

      **The right shape for the goal that matters, with one real dependency to be honest about.**

      *Identity portability.* This is the thing atproto is actually good at, and it is good at it in
      a way ActivityPub is not. An account is a permanent DID with a human-readable domain handle
      in front of it; the repository of records is signed, and a **rotation key held separately from
      the signing key** means an account can be moved to a new PDS *without the original host's
      cooperation*. That last clause is the whole point. "Portable identity" that requires the
      instance you are leaving to help you leave is not portable, and it is exactly the property a
      forge needs: somebody signs in here with an identity this instance did not issue and cannot
      hold hostage.

      *Does the lexicon fit a forge?* Tangled has already answered this by doing it -
      `sh.tangled.repo.pull`, `sh.tangled.repo.issue`, `sh.tangled.repo.collaborator`,
      `sh.tangled.git.refUpdate` - so forge objects in a lexicon is demonstrated rather than
      theoretical. Their split is also the one this phase should copy: **git stays git.**
      Repositories live on ordinary servers (their "knots", lightweight and headless, single or
      multi-tenant), and atproto carries the events *around* the code - issues, pulls, collaborator
      invites, ssh keys, follows, stars. Their own framing is that this is "quite like hosting your
      own cgit instance, and sending out patches via email", which is a good description of a
      forge that federates conversation without pretending to replicate a repository.

      *What a PDS costs.* A self-hoster runs one PDS and can depend on existing relays and
      AppViews rather than building them. On the scale this product targets - one box, a handful of
      people - a PDS is a small service beside the ones already declared in `config/deps.ts`.

      *Infrastructure outside our control, stated plainly.* This is the honest cost. The relay and
      AppView layers are, in practice, largely operated by Bluesky today, and `did:plc` - the
      common DID method - resolves through a directory that is not ours either. `did:web` avoids
      the directory at the price of tying identity to a domain, which for a company instance is
      often acceptable and for an individual is the thing they wanted to escape. A design that
      cannot degrade when the relay is unreachable would be a design that made this product depend
      on somebody else's uptime, which is not a trade a self-hosted forge may make.

      **That constraint is what decides the shape below**: sign-in verifies a DID and a signature,
      which needs resolution and nothing more; nothing on the request path waits on a relay.
- [x] **Neither, for now.** Legitimate. If the honest answer is that federation serves nobody's
      current use case, record that and revisit.

      Considered and rejected as the *whole* answer, but half-right, and the half it is right about
      is content: replicating issues and reviews across instances serves nobody's current use case
      here, and that half is recorded as not-now rather than as never. The identity half is not in
      that position - the drive-by contributor is a real user with a real problem today.

## If a protocol is chosen

Answered as design for AT Protocol. The resolution and the link are now built - `app/Actions/Atproto`
and `POST /api/user/atproto` - and what is not built is named at the end.

- [x] Actor model: are repositories actors, are users actors, are both

      **People are actors; repositories are not.** A person is a DID with a PDS and a signing key -
      an actor in the protocol's own terms. A repository is a resource this instance hosts, named
      by URL, and the records *about* it (an issue, a pull, a ref update) are records in the actor's
      repository rather than in the repository's. Making a repository an actor would mean giving it
      a PDS and a key, and then asking what happens to that identity when the repository is
      transferred, renamed or deleted - three things that happen routinely and none of which an
      identity survives well.
- [x] Signed requests and key management

      Records are signed by the account's signing key, held by the PDS; the **rotation key stays
      with the person**, which is what makes the account portable. This instance verifies rather
      than signs on anybody's behalf: it resolves the DID, checks the signature, and stores the DID
      alongside the local user row. Notably this means **this instance never holds a credential that
      can act as somebody elsewhere** - the same rule phase 13 arrived at independently for
      write-through review, and for the same reason.
- [x] Inbox and outbox delivery, with retries

      **Not needed for the identity half, and that is a reason to prefer it.** There is no inbox to
      defend, no outbox to drain, no retry queue to operate, because nothing is being delivered:
      sign-in is a verification, not a message. This is the largest single piece of work
      ActivityPub would have required, and choosing the identity goal removes it rather than
      deferring it.
- [x] Which objects federate, and which stay local. Reviews carry line-anchored context that assumes
      access to the diff, which is the hardest thing here.

      **In the chosen design: none of them, and the identity does the crossing instead.** Which is
      the answer to the hard question rather than an evasion of it - a review comment anchored to a
      line of a diff is only meaningful to a reader who can fetch that diff, and a federated copy of
      the comment without the repository is a sentence pointing at nothing. ForgeFed's `CodeQuote`
      addresses this by embedding the quoted code in the object, which works for a snippet and not
      for "this reads better as a fold" against a 400-line hunk.

      If content federation is ever revisited, the first objects would be issues and issue comments
      - self-contained prose - and reviews would stay local until somebody has a good answer for the
      diff, not before.
- [x] Moderation: blocking instances and users, and what happens to already-federated content

      A DID that signs in is a local account like any other: it can be suspended, and suspension is
      already in phase 11's deprovisioning path. Blocking is therefore per-identity and local, with
      no already-federated content to reason about, because nothing was federated. **This is the
      moderation question shrinking to something a single operator can actually answer**, which is
      itself an argument for the identity-first choice.
- [x] Spam. An open federation endpoint is an open door.

      There is no open endpoint in this design. The exposure is instead "anybody with a DID can sign
      in", which is the same exposure as "anybody with an email address can register" and is handled
      by the controls that already exist: an instance setting for who may sign in, and the rate
      limits already on the auth routes. An instance that wants to be closed stays closed.
- [x] Interoperability testing against a real instance of whatever else implements it

      **Done for resolution, against the live network rather than a fixture**, and it is the reason
      the implementation is right. `bsky.app`, `jay.bsky.team`, `atproto.com` and a bare
      `did:plc:ewvi7nxzyoun6zhxrhs64oiz` all resolve to their DID, handle and PDS through the real
      PLC directory in 80-420ms.

      The first version resolved none of them. It asked only for `/.well-known/atproto-did`, which
      is in the specification, and its unit tests passed - but handles publish `_atproto` as a DNS
      TXT record and mostly serve no well-known path at all. A design that is right about the
      specification and wrong about the network is wrong, and only pointing it at the network said
      so. TXT is tried first now and the well-known path second, for the host behind a CDN with no
      control of its own DNS.

      What is *not* interoperability-tested is the signature step, because it needs a PDS to sign
      against and this instance cannot yet ask for one. That gap is named in the box below rather
      than left for somebody to discover.

## What is built, and what the gap is

- [x] Resolution, verified in both directions, depending on nothing anybody else operates

      A handle claims a DID and the DID document has to claim the handle back. Without that second
      direction, registering a domain and pointing it at somebody else's DID would sign you in as
      them. Cached for ten minutes; a directory that is slow makes a first link slow and nothing
      else happen at all. Nothing asks a relay or an AppView anything, which is the dependency this
      phase refused to take.
- [x] Linking an identity to an account, and unlinking it

      `POST /api/user/atproto`. A DID is unique across the instance, because an identifier is one
      account and two users claiming it would make "signed in as this identity" ambiguous exactly
      when it matters. A DID already linked elsewhere is refused with the same sentence whoever
      asks, so the endpoint cannot be used to find out which identities exist here.
- [x] Signing *in* with a DID, which is the box that removes the registration form

      **Built, as OAuth, which is what the protocol actually uses.** The earlier note here said a
      session needs "a challenge signed by the account's key at its PDS" - right instinct, wrong
      mechanism. That key signs repository commits, and no endpoint will sign an arbitrary nonce for
      a third party. The proof that somebody controls an identity is an authorization at their own
      server, and `app/Actions/Atproto/oauth.ts` is that flow.

      Four mechanisms, each closing one hole:

      | | |
      |---|---|
      | discovery from the identity | a caller cannot name the server that vouches for them |
      | PKCE, S256 | an intercepted code is useless without a verifier that never left this process |
      | DPoP, ES256, nonce replayed | an intercepted token is useless without the key it is bound to |
      | `sub` checked against the identity the flow began as | an authorization server cannot answer with somebody else |

      The last one is the one an implementation can omit and still appear to work, so it has its own
      test, as does the DPoP proof actually verifying against the key it publishes.

      The pending row holds the verifier and the DPoP key **server-side**: a key in a cookie is a key
      the browser has, and a token bound to it is bound to nothing. It is single-use, consumed before
      the exchange, so a callback URL replayed out of a log or a referrer finds nothing.

      **Signing in requires an identity somebody already linked.** Creating an account for an unknown
      DID would be an open registration endpoint wearing a protocol as a disguise, on instances whose
      operators deliberately closed registration - so an unknown identity is told to link it from an
      account instead. The drive-by contributor still meets one registration, once, on the instance
      they choose; what they no longer meet is a *password* per forge.
- [x] Interoperability, against the live network rather than a fixture

      `bsky.app` resolves to its DID, handle and PDS, and that PDS to `bsky.social`'s PAR,
      authorization and token endpoints. Both bugs that mattered came from running it rather than
      testing it:

      - the first version resolved handles by `/.well-known/atproto-did` alone, which is in the
        specification and resolved **none** of `bsky.app`, `jay.bsky.team` or `atproto.com`, because
        handles publish `_atproto` as a DNS TXT record. TXT first now;
      - `APP_URL` is a bare host in this deployment, and every URL here was built by passing it to
        `new URL`, which throws on one. A missing scheme is filled in - http for localhost, https
        for anything else, because a sign-in redirect over http is a session handed to the path.

      What is still untested end to end is a human completing an authorization, which needs somebody
      to sign in at a real PDS with a real account. The machinery either side of that redirect is
      tested; the redirect itself waits for a person.
## Prerequisites

- [x] Phases 1 through 5 done. Federating a model that is still changing shape means changing it on
      both sides of a protocol.

      Met: 01 (77/77), 02 (130/130), 03 (37/37), 04 (95/95), 05 (52/52).
