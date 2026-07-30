# 10 - Federation

Research, not a commitment. The question is whether an issue opened on one instance can be answered
from another, and whether a pull request can cross instances without either side losing track.

Do not start building until the decision below is written down here with reasons. Federation touched
early and half-heartedly is worse than no federation, because the data model bends around it.

## The question

- [ ] Write down what federation is actually for here. Two candidates, and they pull in different
      directions:
  - Identity portability: one account, usable across instances, so contributors do not register
    everywhere
  - Content federation: issues, pull requests, and reviews replicating across instances
- [ ] Decide which of those matters, or that neither does yet

## Options to evaluate

- [ ] **ActivityPub with ForgeFed.** The specification exists, Forgejo has an implementation to
      learn from, and it fits the fediverse. Evaluate: how complete ForgeFed actually is, what
      Forgejo shipped versus what it planned, and how a pull request across instances behaves in
      practice rather than in the specification.
- [ ] **AT Protocol**, the approach Tangled takes. Evaluate: identity portability, whether the
      lexicon fits a forge's objects, what a PDS costs to run, and how much of this depends on
      infrastructure outside our control.
- [ ] **Neither, for now.** Legitimate. If the honest answer is that federation serves nobody's
      current use case, record that and revisit.

## If a protocol is chosen

- [ ] Actor model: are repositories actors, are users actors, are both
- [ ] Signed requests and key management
- [ ] Inbox and outbox delivery, with retries
- [ ] Which objects federate, and which stay local. Reviews carry line-anchored context that assumes
      access to the diff, which is the hardest thing here.
- [ ] Moderation: blocking instances and users, and what happens to already-federated content
- [ ] Spam. An open federation endpoint is an open door.
- [ ] Interoperability testing against a real instance of whatever else implements it

## Prerequisites

- [ ] Phases 1 through 5 done. Federating a model that is still changing shape means changing it on
      both sides of a protocol.
