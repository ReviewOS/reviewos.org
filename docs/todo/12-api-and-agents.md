# 12 - The API and agents

A coding agent is a contributor now. It opens pull requests, it reads diffs, it answers review
comments, and it does all of that through a token rather than a browser. Every forge in this space
was designed for a person with a mouse and grew an API afterwards, which is why the API is always the
second-class surface: it lags the interface, it exposes a different vocabulary, and the credential
it accepts is either too weak to do the job or so broad that handing it to a script is a decision
nobody wants to sign off on.

That last one is the concrete complaint that started this phase. On GitHub, `packages:read` cannot be
granted by a fine-grained token at all, so an agent that needs to read one package is issued a classic
token carrying every scope on the account. The rule that fixes it lives in
[phase 1](./01-foundation.md#access-tokens); this phase is the rest of the surface that has to be
right for the rule to be worth anything.

The bar: anything a person can do in the interface, a token can do through the API, in the same
vocabulary, and it is discoverable without reading the source.

## Parity

- [ ] Every interface action has an API equivalent, because both call the same action in
      `app/Actions/`. Where the interface reaches somewhere the API cannot, that is a bug filed
      against this list, not a design decision.
- [ ] One vocabulary. The API says `repository`, `pull request`, `review thread` and `stack`,
      matching the table in `AGENTS.md`, rather than a second set of names for the same things.
- [ ] The OpenAPI document is generated from the actions (`./buddy generate:openapi`) and published,
      so it cannot drift from what the server accepts
- [ ] A generated TypeScript client, built from that document rather than maintained by hand
- [ ] Tests that walk the route table and fail on a route with no OpenAPI operation

## Built for a program, not a person with curl

- [ ] Cursor pagination with a stable total ordering. Offset pagination over a table people are
      actively writing to silently skips and repeats rows, and a paginating agent will hit it.
- [ ] `ETag` and `If-None-Match` on read endpoints. An agent that polls should be cheap to serve, so
      the honest answer to polling is to make it free rather than to forbid it.
- [ ] Idempotency keys on anything that creates. Agents retry on timeout, and the current behavior of
      every forge is to create the comment twice.
- [ ] Rate limits that are documented, returned in headers on every response rather than only on the
      rejection, per token rather than per account, and paired with a `Retry-After` that is true
- [ ] Errors that name the field and the fix, with a stable machine-readable code. "Validation
      failed" costs a retry loop that will never succeed.
- [ ] Partial responses: ask for the fields you need. A pull request list that always carries every
      body is expensive on both ends.
- [ ] A structured diff endpoint: hunks, ranges and line origins as JSON, from the same parser the
      review screen uses. Scraping the rendered diff should never be the only way to get one.
- [ ] Submit a whole review in one request: many comments plus a verdict, atomically. A review
      assembled by twelve round trips is twelve chances to leave half a review behind.
- [ ] Webhooks are the supported way to stay current (phase 5), and every event that changes
      something an agent cares about has one

## Agents as a first-class kind of contributor

Not a special case bolted on. A machine account is an account, subject to the same permission
resolution, and the differences are the ones that genuinely matter.

- [ ] Machine accounts (defined in [phase 1](./01-foundation.md#living-with-tokens)) can be authors,
      reviewers and assignees like anyone else
- [ ] Attribution is visible: a pull request opened by a machine account, or a review submitted by
      one, says so plainly in the interface. Not to shame it, but because a reader's standard for
      "somebody looked at this" depends on who looked.
- [ ] An approval from a machine account counts toward required approvals only if the repository
      opts in. Default off, because the failure mode is a branch protected by a robot approving its
      own class of change.
- [ ] Per-token limits an owner can set: how many pull requests, comments or reviews an hour. The
      first bad agent loop is not malice, it is a retry with no backoff, and the repository should
      survive it.
- [ ] Everything a token did is in the audit log, attributable to the token and not only to the
      account behind it
- [ ] Repository rules can require that an agent-authored change carries a human approval before it
      merges, expressed as a rule rather than as a convention people remember

## MCP

The Model Context Protocol is how an agent gets tools, and Stacks already ships MCP support
(`stacks-ai`), so this is wiring rather than invention.

- [ ] A ReviewOS MCP server exposing the review surface as tools: list what is waiting on me, read a
      pull request, read its diff by file, comment on a line, submit a review, read a check's output
- [ ] Tools are scoped by the token that authenticates the connection, with no ambient authority.
      The agent gets exactly the token's permissions and nothing that leaks from the server process.
- [ ] Read tools return the structured diff, not HTML
- [ ] Self-hostable alongside the instance, and documented in the self-hosting guide
- [ ] Tests: a tool call against a repository the token cannot read fails the same way the API does

## Command line

- [ ] A CLI for the operations that belong in a terminal: open a pull request from the current
      branch, check out someone else's, see the stack, submit a review from a file
- [ ] It authenticates with the same fine-grained tokens, and stores them in the OS keychain rather
      than a dotfile
- [ ] It is a client of the public API only. If the CLI needs an endpoint that does not exist, the
      endpoint gets built, which keeps parity honest.
