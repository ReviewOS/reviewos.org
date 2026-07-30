# 07 - Marketing and documentation

The public face: what reviewos.org shows a visitor, and the documentation someone reads when they
decide to run it.

## Landing page

- [x] Design and build `resources/views/index.stx` using the `stacks-design-taste` skill
- [x] Section components under `resources/components/Marketing/`
- [x] Light and dark, following the skill's dark mode protocol
- [x] No em-dashes in any user-visible copy, per the house pre-flight rule
- [x] stx signals and composables only; no vanilla DOM access in templates
- [x] Crosswind utilities for styling, Iconify classes for icons, no icon packages and no hand-rolled
      SVG paths
- [x] Responsive down to a phone, with the hero legible without scrolling
- [ ] Screenshots of the actual review interface, once phase 4 exists. Placeholders now, replaced
      then; shipping invented screenshots of software that does not exist yet is not acceptable.
- [ ] Open Graph and Twitter card metadata, with a generated social image
- [ ] Lighthouse pass: no layout shift, fonts preloaded, images sized

## Documentation site

- [x] bunpress configured through `config/docs.ts`, served by `./buddy dev:docs`
- [x] Roadmap published as task lists that render as checkboxes
- [ ] Getting started: requirements, install, first repository
- [ ] Configuration reference: every environment variable that matters, and what it does
- [ ] Architecture: how a request becomes a git operation, and where repositories live on disk
- [ ] API reference for the JSON API, generated from the actions rather than written by hand
- [ ] Webhook payload reference
- [ ] Contributing guide: the model to migration to action to route to view order, and the
      expectation that roadmap boxes are ticked in the same commit as the work
- [ ] Search across the docs

## Self-hosting guide

- [ ] Requirements and sizing, with honest numbers rather than optimistic ones
- [ ] Install with pantry, and install with Docker
- [ ] Reverse proxy and TLS
- [ ] SMTP configuration for notifications
- [ ] Backup and restore, covering both Postgres and the repository directory. Documented only after
      it has actually been restored from, not merely written.
- [ ] Upgrading, including migrations
- [ ] Hardening checklist

## Brand

- [ ] Wordmark and icon
- [ ] Favicon set
- [ ] Colour and type scale recorded so the marketing page and the application agree
- [ ] Social preview image
