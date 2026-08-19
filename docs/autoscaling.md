# Autoscaling runners

What an autoscaler needs from this instance, what it has to do itself, and a
reference one you can read in five minutes.

## The contract

Scrape `/api/metrics`. Everything a scaler needs is there and nothing else is:

```
reviewos_ci_jobs_waiting{queue="linux-x64-large"} 7
reviewos_ci_jobs_running{queue="linux-x64-large"} 2
reviewos_ci_jobs_oldest_waiting_seconds{queue="linux-x64-large"} 94
reviewos_ci_runners{queue="linux-x64-large",lifecycle="idle"} 1
reviewos_ci_runners{queue="linux-x64-large",lifecycle="running"} 2
reviewos_ci_runners{queue="linux-x64-large",lifecycle="stopping"} 0
reviewos_ci_runners{queue="linux-x64-large",lifecycle="lost"} 0
reviewos_ci_runners{queue="linux-x64-large",lifecycle="disabled"} 0
reviewos_ci_runners{queue="linux-x64-large",lifecycle="never-seen"} 0
```

Three facts per queue - work waiting, work running, how long the oldest has
waited - and machines by what they are actually doing. A scaler that needed more
than this would be making decisions that belong to the instance.

Four things worth knowing about the shape:

**Every series is reported at zero.** A gauge that disappears when it reaches
zero is how a scaler concludes there is no work, when what happened is that
nobody reported any.

**`unassigned` is a real queue name.** It carries the machines nobody put in a
queue, and the jobs whose `runs-on:` matches no runner anywhere. On an instance
that has started using pools, that bucket is where the surprises are.

**`lost` is the one nobody sets.** A machine that stopped talking is not
`stopped`, because nothing stopped it - it is a lease that lapsed and a poll
that never came. If your scaler kills machines, `lost` climbing is how you find
out it is killing them mid-job.

**Scale on `waiting`, alarm on `oldest_waiting_seconds`.** The first is what to
do; the second is whether it worked. A queue whose oldest job keeps aging while
`runners` is zero is not a scaling problem, it is a scaler that is not running.

## What the scaler does

**Carry a registration token, not an administrator's token.** Mint one once,
scoped to a pool, and put *that* in the machine's userdata:

```sh
curl -sX POST https://reviewos.example/api/instance/fleet \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"operation":"create-token","pool":3,"queue":7,"name":"us-east autoscaler"}'
```

The machine registers itself with it and is handed its own credential, which is
what it uses from then on:

```sh
curl -sX POST https://reviewos.example/api/runner/register \
  -H "Authorization: Bearer $REGISTRATION_TOKEN" -H 'X-Runner-Protocol: 1' \
  -H 'Content-Type: application/json' \
  -d '{"name":"build-07","labels":"ubuntu-latest,self-hosted","tags":"gpu=a100,region=ash"}'
```

A registration token can do exactly one thing - add a machine to one pool - so
that is the whole blast radius when a machine is compromised or a userdata blob
leaks. An administrator's token in the same place can read every repository on
the instance. Revoke it with `{"operation":"revoke-token","token":12}`: new
machines stop joining, and builds already running on machines that joined
earlier are not interrupted.

`tags` are what the machine knows about itself, and what a job's
`agents: [gpu=a100]` query selects on. Set them from the startup script, which is
the only thing that knows.

The remaining calls live on `/api/instance/fleet` and need an administrator's
token, or a **pool maintainer's** - a role that can drain queues, mint tokens and
stop machines in one pool without being able to read a single repository:

```sh
# Make a machine's credential, seconds before the machine exists.
# The token is returned once; the column holds a hash.
curl -sX POST https://reviewos.example/api/instance/fleet \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"operation":"create-runner","name":"build-07","queue":3,"labels":"ubuntu-latest,self-hosted"}'

# Move an existing machine into a queue
curl -sX POST https://reviewos.example/api/instance/fleet \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"operation":"assign-runner","runner":42,"queue":3}'

# Ask it to stop
curl -sX POST https://reviewos.example/api/instance/fleet \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"operation":"stop-runner","runner":42}'
```

`create-runner` is the one a scaler actually needs. `buddy runner:local
--register` is an operator at a shell on the instance's own host; a scaler is a
program somewhere else that has to mint a credential in the same second it asks
a cloud provider for a machine.

**Prefer letting the runner stop itself.** `--idle-timeout 300` on the runner is
better than a scaler deciding when to kill it, because the runner knows whether
it is mid-job and a scaler outside it has to guess. Use `stop-runner` when you
need the machine gone for a reason the runner cannot know about - a spot
instance being reclaimed, a queue being drained for maintenance.

`stop-runner` is graceful by default: no new work, and the machine is told the
next time it asks. `{"force":true}` also puts the job it was holding **back in
the queue** - not cancelled, because the work is fine and it is the machine that
is going away. Somebody watching a pull request should not see their build fail
because the fleet shrank.

## Preparing a machine

No container runtime, no configuration management, no image to bake. A runner
needs git, the toolchains its jobs use, and the runner binary:

```sh
# pantry: the package manager, and the tools
curl -fsSL https://pantry.dev | bash
pantry install git

# the runner itself, built on the instance with `buddy build:runner`
curl -fsSL 'https://reviewos.example/api/runner/download?target=linux-x64' -o /usr/local/bin/reviewos-runner
chmod +x /usr/local/bin/reviewos-runner

reviewos-runner --url https://reviewos.example --token "$RUNNER_TOKEN" --idle-timeout 300
```

**Toolchains come from pantry rather than from an image.** `pantry install
node@22 python@3.12` on a machine is the whole of it, and a machine that needs a
different version tomorrow installs it rather than being rebuilt. That is the
difference between a fleet of general-purpose machines and a fleet of images
somebody has to bake every time a version changes - and it is why there is no
Dockerfile anywhere in this documentation.

It is not isolation, and this documentation will not pretend otherwise: steps run
as the user who started the runner. Isolation is a separate machine, which is
what an autoscaler is already giving you - one job per machine with `--jobs 1`
is the strongest boundary this design offers, and it is a strong one.

## The fleet as a file

A fleet that cannot be declared is a fleet that drifts: a pool created during an
incident, a queue paused on a Friday and never resumed, and six months later
nobody can say what the intended shape was.

```yaml
# fleet.yml
pools:
  - name: Deployment
    description: machines with the release credentials
    require_signed_steps: true
    queues:
      - name: linux-x64
      - name: macos-arm64
        state: paused
        reason: waiting for the new mac mini
    repositories:
      - acme/api
      - acme/web
```

```sh
buddy fleet:apply fleet.yml --plan   # what would change, touching nothing
buddy fleet:apply fleet.yml
```

Applying twice does nothing the second time, so the file is safe to run from a
pipeline. **Nothing is ever removed**: anything on the instance that the file
does not mention is reported as drift and left alone, because the failure mode
of a convergence tool has to be "nothing happened" rather than "everything went
away" on the day somebody applies a partial file.

## macOS machines

Mobile delivery runs on macOS and nothing else can, which makes these the
machines a fleet cannot treat as cattle: Apple's licence ties macOS to Apple
hardware, so a mac is a machine somebody bought or a tenant somebody rents by
the hour rather than an instance an autoscaler creates in twenty seconds. Every
CI product handles this case worst, and the reason is always the same: a design
that assumes a machine is disposable, applied to one that is not.

So they are configured like any other runner and labelled honestly:

```sh
reviewos-runner --url https://reviewos.example --token "$RUNNER_TOKEN" \
  --labels macos,macos-14,self-hosted \
  --tags xcode=16.2,arch=arm64,notarization=yes
```

A job asks for one the same way it asks for anything:

```yaml
jobs:
  release:
    runs-on: macos
    reviewos:
      agents:
        xcode: '16.2'
```

Three things follow from a mac being long-lived rather than disposable, and they
are the difference between a fleet that works and one that produces a mystery
every fortnight:

- **Put them in their own pool.** A pool is a boundary: these machines hold
  signing material and store credentials, and a pool that also takes pull
  request checks from every repository on the instance is one where somebody
  else's dependency runs beside the keychain. `assign-repository` narrows it
  further, to the repositories that actually ship.
- **`--jobs 1` is not available to you, so clean up instead.** An ephemeral
  Linux runner gets a fresh machine per job; a mac gets the same one for a year.
  The `cleanup` hook is where a derived-data directory, a simulator that stayed
  running and a keychain that stayed unlocked get dealt with - see
  [runner hooks](./runner-hooks.md).
- **Say which Xcode is on it, in `--tags`.** A build that needs 16.2 and lands
  on 15.4 fails halfway through with an error about a Swift version, which is a
  worse afternoon than being queued.

**Signing material belongs to an environment, not to the repository.** A
certificate and a store password in a repository secret reach every job in every
run, including the build job that runs whatever the dependency tree brought with
it. In an environment they reach the publish job, after its gate:

```yaml
jobs:
  build:
    runs-on: macos
    steps:
      - run: xcodebuild -scheme App archive
  publish:
    needs: build
    runs-on: macos
    environment: app-store
    steps:
      - run: ./publish.sh
        env:
          SIGNING_KEY: ${{ secrets.SIGNING_KEY }}
          STORE_TOKEN: ${{ secrets.STORE_TOKEN }}
```

The build job cannot read either, and asking for them by name does not change
that: naming a secret narrows what a job receives rather than widening it. See
[secrets](./secrets.md), and the environment's own reviewers and wait timer in
[environments](./environments.md).

## A reference autoscaler

Hetzner Cloud, about a hundred lines, and deliberately boring. Copy it and change
the provider call; the shape is the same everywhere.

```bash
#!/bin/sh
# Poll the instance, and keep one machine per waiting job up to a ceiling.
set -eu

INSTANCE="https://reviewos.example"
QUEUE="linux-x64-large"
MAX=5

waiting() {
  curl -fsS "$INSTANCE/api/metrics" -H "Authorization: Bearer $METRICS_TOKEN" \
    | awk -v q="$QUEUE" '$0 ~ "reviewos_ci_jobs_waiting\\{queue=\""q"\"\\}" { print $2 }'
}

idle() {
  curl -fsS "$INSTANCE/api/metrics" -H "Authorization: Bearer $METRICS_TOKEN" \
    | awk -v q="$QUEUE" '$0 ~ "reviewos_ci_runners\\{queue=\""q"\",lifecycle=\"idle\"\\}" { print $2 }'
}

# Scale up: one machine per waiting job, capped. The runner exits by itself
# when the queue has been empty for five minutes, so there is no scale-down
# path to write and no chance of killing one mid-job.
want=$(waiting)
have=$(idle)
need=$((want - have))

[ "$need" -gt "$MAX" ] && need=$MAX

i=0
while [ "$i" -lt "$need" ]; do
  name="runner-$(date +%s)-$i"

  token=$(curl -fsSX POST "$INSTANCE/api/instance/fleet" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"operation\":\"create-runner\",\"name\":\"$name\"}" | jq -r .runner.token)

  curl -fsSX POST https://api.hetzner.cloud/v1/servers \
    -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' \
    -d "{
      \"name\": \"$name\",
      \"server_type\": \"cpx11\",
      \"image\": \"ubuntu-24.04\",
      \"location\": \"ash\",
      \"user_data\": \"#cloud-config\\nruncmd:\\n  - curl -fsSL https://pantry.dev | bash\\n  - pantry install git\\n  - curl -fsSL '$INSTANCE/api/runner/download?target=linux-x64' -o /usr/local/bin/reviewos-runner\\n  - chmod +x /usr/local/bin/reviewos-runner\\n  - reviewos-runner --url $INSTANCE --token $token --idle-timeout 300; shutdown -h now\"
    }"

  i=$((i + 1))
done
```

The scale-*down* path is the interesting part, and it is that there isn't one:
the machine shuts itself off when the queue has been empty for five minutes, and
`shutdown -h now` after the runner exits means the server bill stops with it.
A scaler that decides when to kill runners has to answer "is it mid-job", and it
cannot.

**What this leaves you to do**: delete the powered-off servers (a second cron, or
your provider's own reaping), and decide what happens when a machine never
registers - `reviewos_ci_runners{lifecycle="never-seen"}` climbing means
credentials are being made for machines that never arrive, which is usually a
cloud-init that failed.
