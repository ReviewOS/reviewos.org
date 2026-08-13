# 07 - Marketing and documentation

The public face: what reviewos.org shows a visitor, and the documentation someone reads when they
decide to run it.

## Landing page

- [x] Design and build `resources/views/index.stx` using the `stacks-design-taste` skill
- [x] Nav and footer as components in `resources/components/`
- [x] Light and dark, following the skill's dark mode protocol
- [x] No em-dashes in any user-visible copy, per the house pre-flight rule
- [x] stx signals and composables only; no vanilla DOM access in templates
- [x] Iconify classes for icons, no icon packages and no hand-rolled SVG paths
- [x] Styling is a scoped `<style>` block over CSS custom properties rather than Crosswind
      utilities, because the page carries its own two-theme token set. Revisit if the marketing
      page and the application need to share a system.
- [x] Responsive down to a phone, with the hero legible without scrolling
## Marketing site structure

Modelled on the uptimestatus marketing site: one catalog feeding the navigation, a page per
feature, a page per use case, and comparisons that say plainly what the alternative does better.

- [x] `resources/functions/marketing.ts` as the single catalog of features, use cases, and
      comparisons, so a page and its menu entry cannot drift apart
- [x] `resources/views/layouts/marketing.stx` shared by every marketing page below the landing one
- [x] Features mega menu, grouped into Review, Repositories, Automation, and Operations, built from
      the catalog and present on the landing page too
- [x] A page per feature under `/features/<slug>`, twelve of them, each with its own argument
      rather than a restatement of the summary
- [x] Agentic usage as a first-class feature: `/features/agentic-review`, and a use case at
      `/for/ai-assisted-teams`, because review is the control that matters when agents write
      most of the diffs
- [x] Use cases mega menu and a page per audience under `/for/<slug>`
- [x] Comparison pages under `/compare/<slug>` for GitHub, GitLab, and Forgejo, each stating what
      the alternative genuinely does better
- [x] Index pages at `/features`, `/for`, and `/compare`
- [x] Footer linking every feature, use case, and comparison
- [ ] Pricing page, if a hosted offering ever exists
- [ ] Per-feature screenshots, once the review interface renders real data

## Landing page

- [ ] Screenshots of the actual review interface, once phase 4 exists. Placeholders now, replaced
      then; shipping invented screenshots of software that does not exist yet is not acceptable.
- [x] Contrast measured rather than eyeballed: every text pair passes WCAG AA in both themes
- [ ] Remove the leftover template assets in `resources/assets/` (2.8 MB of images, a demo
      stylesheet, and a demo script) once nothing in the build references them
- [ ] Open Graph and Twitter card metadata, with a generated social image
- [ ] Lighthouse pass: no layout shift, fonts preloaded, images sized

## Documentation site

- [x] bunpress configured through `config/docs.ts`, served by `./buddy dev:docs`
- [x] Roadmap published as task lists that render as checkboxes
- [x] Roadmap index counts and "not started" states are checked by `tests/unit/roadmap.test.ts`, so
      completing work cannot leave the summary silently stale
- [x] Getting started: requirements, install, first repository, and what a push actually does
- [x] Configuration reference: every environment variable that matters, and what it does.
      `docs/configuration.md` is generated from `.env.example` and the source that reads each
      variable, so it says where a value is used, which ones the boot check validates, and which
      ones git sets for a hook rather than you. The hand-written table it replaced still named
      Meilisearch months after the move to Typesense, which is the argument for generating it.
- [x] Architecture: how a request becomes a git operation, where repositories live on disk, and the
      two planes checks run in
- [x] API reference for the JSON API, generated from the actions rather than written by hand.
      `buddy docs:reference` writes `docs/api.md` from the OpenAPI document and `docs/webhooks.md`
      from the payload module; `--check` and `tests/unit/docs-reference.test.ts` fail when the
      committed copies have drifted, because a generator nobody runs is a hand-written page with
      extra steps.
- [x] Webhook payload reference, every event from `WEBHOOK_EVENTS` with the envelope described once
- [ ] Declare the remaining endpoints' inputs on their actions. 27 of 157 operations carry a
      `validations` block; the other 130 validate inside the handler, so the document has nothing to
      publish for them and the page names the action instead of guessing. The test holds that count
      from growing.
- [x] Contributing guide: the model to migration to action to route to view order, and the
      expectation that roadmap boxes are ticked in the same commit as the work
- [x] Search across the docs. The overlay had been rendering, taking a query, and answering
      nothing: it fetches `/search-index.json`, which bunpress serves from 0.2.0 on, and the
      framework pinned `^0.1.18`. Bumped upstream, released as Stacks 0.70.370, and verified here -
      a query returns hits across the guides, the roadmap, and the generated API reference.

## Self-hosting guide

- [x] Requirements and sizing, with honest numbers rather than optimistic ones. Measured on a real
      instance: boot to serving, resident memory idle and after a hundred requests, ref
      advertisement and a full clone of a 190 MiB pack.
- [x] Install with pantry, and install with Docker. Both paths, with the systemd units for the
      non-Docker one and why `TimeoutStopSec` has to be above the drain window.
- [x] Reverse proxy and TLS, including the `x-forwarded-proto` that decides whether the session
      cookie is marked `Secure` - getting it wrong is a login that appears to work and returns you
      signed out.
- [x] SMTP configuration for notifications, starting with the fact that the default driver is `log`
      and sends nothing, which in production is a password reset nobody receives.
- [x] Backup and restore, covering both Postgres and the repository directory. Documented after
      restoring from it against a copy, not merely written.
- [x] Upgrading, including migrations, and which failure is the one where the answer is "restore"
      rather than "fix and re-run"
- [x] Hardening checklist: what an instance should look like before other people depend on it,
      every line of it covered elsewhere on the page

## Brand

- [ ] Wordmark and icon
- [ ] Favicon set
- [ ] Colour and type scale recorded so the marketing page and the application agree
- [ ] Social preview image
