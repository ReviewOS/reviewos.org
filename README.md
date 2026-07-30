# ReviewOS

An open source, self-hostable git forge built around code review.

Most forges treat review as a tab on a pull request. ReviewOS treats it as the primary object: the
repository browser, the diff viewer, and the notification system all exist to make reviewing code
better. Stacked pull requests, review threads that survive a force-push, and a diff that stays fast
at a hundred files are the point, not the extras.

> ReviewOS is early. The roadmap in [docs/todo](./docs/todo/) is the honest picture of what exists
> and what does not.

## What it will do

- Host git repositories over HTTPS, for users and organizations
- Issues, labels, and milestones
- Pull requests with first class reviews: approvals, requested changes, and threads anchored to a
  file, line, and side of the diff
- Webhooks, notifications, and a searchable explore page
- Run on your own hardware, with your data in your own Postgres

## Requirements

- [Bun](https://bun.sh) 1.3.14 or newer
- PostgreSQL 17
- git 2.47 or newer

Pantry installs and manages all three. You do not need them on your machine beforehand.

## Getting started

```bash
git clone https://github.com/ReviewOS/reviewos.org.git
cd reviewos.org
./buddy setup
```

`./buddy setup` installs the toolchain, starts PostgreSQL, creates the database named in your
`.env`, and runs the migrations. Then:

```bash
./buddy dev
```

## Development

```bash
./buddy lint          # pickier
./buddy typecheck     # app/, config/, resources/, routes/
./buddy test          # test suite
./buddy dev:docs      # documentation site, including the roadmap
```

Data lives in models under `app/Models/`; migrations are generated from them with
`./buddy generate:migrations` and are never written by hand. `AGENTS.md` documents the conventions
in full, for humans as much as for coding agents.

## Contributing

The roadmap in [docs/todo](./docs/todo/) is organized by phase, and every item is small enough to
pick up on its own. Tick the box in the same commit as the work.

## License

[MIT](./LICENSE.md)
