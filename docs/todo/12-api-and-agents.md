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
- [ ] Long-running resources, including CI workflow runs, expose their state machine and control
      operations through the same public actions used by the interface and CLI. No UI-only pause,
      retry, cancellation, log, or approval path.

## Built for a program, not a person with curl

- [x] Cursor pagination with a stable total ordering. Offset pagination over a table people are
      actively writing to silently skips and repeats rows, and a paginating agent will hit it.

  `app/Api/cursor.ts`. The part worth stating is that the ordering has to be *total*: `created_at`
  alone is not, so two rows written in the same millisecond straddle a page boundary and one is
  never returned - the same failure offset has, which would make the rewrite pointless. Every
  ordering ends in the primary key. The caller asks for one row more than the page and it is never
  returned; it answers "is there more" without a `COUNT`, which on a large table costs more than the
  page did.
- [x] `ETag` and `If-None-Match` on read endpoints. An agent that polls should be cheap to serve, so
      the honest answer to polling is to make it free rather than to forbid it.

  `app/Api/etag.ts`. Tags come from cheap facts - a row's `updated_at`, a count, a head sha - never
  from the rendered body, because a tag hashed from the response saves the transfer and nothing
  else, and serving a pull request means reading its comments, reviews, checks and diff stat.
  Weak (`W/`) because that is the true claim: the bytes are not identical a second later, the
  resource is. `If-None-Match` is a list and is compared entry by entry, which is the bug that makes
  conditional requests silently never match.
- [x] Idempotency keys on anything that creates. Agents retry on timeout, and the current behavior of
      every forge is to create the comment twice.

  `app/Api/idempotency.ts`. Four outcomes, and the two unhappy ones matter as much as the replay: a
  recycled key carrying a *different* body is refused rather than replayed, because returning the
  first response for a second request means the second was never created and the client is told it
  succeeded - silent, and worse than the duplicate; and a second request arriving while the first is
  still running is held, because two retries racing is exactly what a timeout produces.

  Keys are scoped to the token and the endpoint. A key is chosen by the client and two clients will
  eventually choose the same one - a bad UUID seed, or the literal `1` - and unscoped, one agent's
  retry returns another agent's response, which is a disclosure rather than a duplicate.
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
- [ ] A consistent operation pattern for asynchronous work: create with an idempotency key, receive
      a resource and status URL, poll cheaply with `ETag`, follow a cursor-based event or log stream,
      and cancel with the same token authority that created it

## Agents as a first-class kind of contributor

Not a special case bolted on. A machine account is an account, subject to the same permission
resolution, and the differences are the ones that genuinely matter.

- [ ] Machine accounts, defined in
      [phase 1](./01-foundation.md#living-with-tokens), can be authors, reviewers and assignees like
      anyone else
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
