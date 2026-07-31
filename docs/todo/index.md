# Roadmap

Every phase below is a checklist. A box is ticked when the work is done, verified, and committed,
and it gets ticked **in the same commit as the work**. An unticked box that is actually finished is
worse than no roadmap at all, because the next person redoes it.

Phases are ordered by dependency, not by importance. Phase 4 is the reason this project exists;
it needs phases 1 and 2 underneath it first.

## Phases

| Phase | What it covers | State |
|---|---|---|
| [00 - Bootstrap](./00-bootstrap.md) | Scaffold, Postgres, tooling, agent setup | Done |
| [01 - Foundation](./01-foundation.md) | Users, organizations, teams, tokens, keys | Not started |
| [02 - Git hosting](./02-git-hosting.md) | Repositories on disk, smart HTTP, code browsing | Not started |
| [03 - Issues](./03-issues.md) | Issues, comments, labels, milestones, markdown | Not started |
| [04 - Reviews](./04-reviews.md) | Pull requests, reviews, diffs, merging, stacks | Not started |
| [05 - Notifications and webhooks](./05-notifications-webhooks.md) | Delivery, subscriptions, webhooks | Not started |
| [06 - Search and explore](./06-search-explore.md) | Indexing, search, discovery | Not started |
| [07 - Marketing and docs](./07-marketing-docs.md) | Landing page, documentation, self-hosting guide | In progress |
| [08 - Migration](./08-migration.md) | Importing from GitHub and other forges | Not started |
| [09 - Checks and CI](./09-checks-ci.md) | Commit status API, then runners | Not started |
| [10 - Federation](./10-federation.md) | Research: ActivityPub / ForgeFed versus AT Protocol | Research |
| [11 - Self-hosting and operations](./11-self-hosting-deploy.md) | Deployment, backups, upgrades, ops | Not started |

## How work is shaped

Stacks resolves a feature in a fixed order, and the checklists follow it:

**model → migration → action → route → view → test**

Concretely, for anything with data behind it:

1. Define or change the model in `app/Models/`. Every attribute gets `validation.rule` and a
   realistic `factory`, and the model gets `useSeeder`, so seeding keeps working without manual
   wiring.
2. Generate the migration with `./buddy generate:migrations` and review the SQL. Never hand-write
   it, and commit the regenerated model snapshot alongside it.
3. Write the action in `app/Actions/<Domain>/`, one per endpoint.
4. Register the route in `routes/`.
5. Build the view in `resources/views/` (file-based, no route registration) with components in
   `resources/components/`.
6. Add tests under `tests/`.

## Deliberately not doing yet

Naming these keeps them from being re-proposed every few weeks:

- **A package registry.** Out of scope until the forge itself is good. When it is reconsidered, its
  permissions (`packages:read`, `packages:write`) are fine-grained token permissions from the first
  commit. See the rule in [phase 1](./01-foundation.md#access-tokens): there is no second token type
  to fall back to, which is exactly the trap this project is avoiding.
- **A wiki.** Repository markdown files cover most of the need.
- **Projects and boards.** Issues with labels and milestones first.
- **In-browser editing.** A pull request from the browser is a phase 4 concern at the earliest.
- **Its own CI runners.** Phase 9 starts with a status API so external CI can report in. Running
  other people's code is a security project of its own.
