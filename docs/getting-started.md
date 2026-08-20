# Getting started

Running ReviewOS on your own machine, from nothing to a repository you have pushed to. Fifteen
minutes, most of it waiting for a toolchain to download.

This page is the local one. For an instance other people use, read [Self-hosting](./self-hosting.md)
instead: it covers TLS, backups, and the parts that only matter when losing the data would be a
problem.

## What you need

Nothing installed beforehand, which is the point of the setup step below. It fetches these through
pantry, into the project rather than onto your system:

- **Bun** 1.3.14 or newer
- **PostgreSQL** 17
- **git** 2.47 or newer
- **gnupg** 2.4.8 or newer, for verifying commit signatures

Git is a real dependency rather than a detail. Repositories are ordinary bare repositories on disk
and every operation on them is the `git` binary, spawned. There is no reimplementation of git here
to go subtly wrong, and there is nothing about your data locked inside this application.

## Install

```bash
git clone https://github.com/ReviewOS/reviewos.org.git
cd reviewos.org
./buddy setup
```

`./buddy setup` installs the toolchain, starts Postgres, creates the database named in your `.env`,
and runs the migrations. It also writes `deps.yaml` from `config/deps.ts` and your `.env`, so that
file is generated and not worth editing.

Then:

```bash
./buddy dev
```

The application comes up on `https://reviewos.localhost`, with a local certificate. If the port is
taken, `PORT` in `.env` moves it.

Before signing in, ask the instance how it is:

```bash
./buddy instance:check
```

It reads the configuration, the database, the queue, and the repository directory, and says what is
wrong and what to do about it. It exits non-zero on anything fatal, so a start script can use it.
A warning about `APP_KEY` in development is expected until you run `./buddy key:generate`; in
production it refuses to start instead.

## The first account

Registration is open by default so the first person can get in, and the first account is exempt from
the closed setting for the same reason: an instance closed before anybody signed up is one nobody
can administer.

Register through the interface. To make that account an administrator:

```bash
psql -U postgres reviewos -c "UPDATE users SET is_admin = true WHERE handle = 'you'"
```

There is no bootstrap command that does this, deliberately. A command that grants administrator
rights is a command somebody can be talked into running.

## A believable instance, without the typing

If you want something to look at rather than something to fill in:

```bash
./buddy seed:demo
```

That writes accounts, organizations, repositories with real history, issues, pull requests with
review threads, and notifications. It is the fastest way to see what a screen looks like with a
hundred files in a diff rather than three.

## Your first repository

**1. Create it.** **New** in the header, which is `/new`, or `POST /api/repos` with a token. A repository is a row
and a bare repository on disk, created together: a row with nothing behind it answers every clone
with a confusing error, and a repository on disk with no row is invisible and never collected.

**2. Get a credential.** Settings, then Tokens. A token carries per-scope access - code, issues,
pull requests, checks, webhooks, administration - each of them none, read, or write. Give it the
least that does the job; the point of scopes is that a token left in a CI config cannot do
everything you can.

**3. Push over HTTPS**, with the token as the password and any user name:

```bash
git remote add origin https://reviewos.localhost/git/you/your-repository.git
git push -u origin main
```

**Or over SSH.** The daemon is separate and off unless you start it, because a git server listening
on a port is a decision rather than a default:

```bash
./buddy git:ssh
```

Add your public key under Settings, then Keys. Clone URLs use `ssh://` and carry the port, because
the short `git@host:path` form has nowhere to put one - the colon is already the path separator:

```bash
git clone ssh://git@localhost:2222/you/your-repository.git
```

Set `SSH_PORT` in `.env` and the repository page starts offering the SSH URL beside the HTTPS one.
Until an operator says where SSH answers, no SSH URL is shown at all: a clone URL that cannot
connect is worse than one fewer, because it looks like the forge is broken rather than like a
feature is off.

## The page on your profile

`/{handle}` is a profile, and the text at the top of it is a markdown file in a repository called
`.profile` - the same for a person and an organization:

```bash
# on the instance, once
git init .profile && cd .profile
printf '# Who we are\n' > README.md
git add . && git commit -m 'the page my profile shows'
git remote add origin https://reviewos.localhost/git/you/.profile.git
git push -u origin main
```

`README.md` at its root is the page. `profile/README.md` is read too, so a profile written for
somewhere else can be copied across without being rearranged.

**Arriving from GitHub**, two more places are read before this one gives up, so an instance that
mirrors an organization shows the page it already publishes: a mirrored `.github` at
`profile/README.md`, which is where GitHub keeps an organization's, and the repository named after
the handle, which is where it keeps a person's.

```bash
./buddy mirror:add --remote yourorg/.github --owner yourorg
```

A mirror added that way is a mirror only the person who typed it knows about, which is how this
instance came to be missing exactly one repository - the profile - while carrying a hundred and
fourteen others. So the set an instance is supposed to have can be a file instead, applied on every
deploy:

```bash
./buddy mirror:apply mirrors.yml --plan   # what would change, touching nothing
./buddy mirror:apply mirrors.yml
```

```yaml
mirrors:
  - remote: yourorg/.github
    owner: yourorg
```

It is additive: a mirror on the instance and not in the file is counted and left alone, so a partial
file can never take a repository off the box, and a line naming an owner that does not exist yet is
skipped rather than fatal. This repository applies its own `mirrors.yml` from the deploy's pre-start
step in `config/cloud.ts`.

All of them are read through the same permission check as any other file, so a private repository is
not a way to publish a page to people who may not see it.

## What happens when you push

Worth knowing early, because it explains most of what you will see afterwards. The push runs through
`pre-receive` and `post-receive` hooks this instance installed:

- Branch protection and push rules are decided **before** the objects are accepted, so a rejected
  push leaves nothing behind.
- Secret scanning reads the incoming objects out of the quarantine directory git gives the hook.
- Afterwards the push is recorded: `pushed_at`, closed issues, cross references, the activity feed,
  and any webhook or check that was waiting on the new head.

Without `GIT_HOOK_SECRET` set, the hooks cannot post back and none of that recording happens - the
objects land and the forge learns nothing about them. `./buddy setup` generates one; `buddy git:hooks`
reinstalls the hooks after you change it.

## Working on ReviewOS itself

```bash
./buddy lint          # pickier, with --fix
./buddy typecheck     # app/, config/, resources/, routes/
./buddy test          # the suite
./buddy dev:docs      # this site, including the roadmap
```

The roadmap in [docs/todo](./todo/) is the honest picture of what exists. A box is ticked in the
same commit as the work it describes, so an empty box means the feature is not there yet rather than
that nobody wrote it down.

If you are about to change something, [Architecture](./architecture.md) explains where things live,
and [Contributing](./contributing.md) explains the order to build them in.
