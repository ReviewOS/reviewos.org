# ReviewOS, as a container.
#
# Two stages. The first installs dependencies and builds; the second carries the
# result and nothing else, because a production image with a package manager and
# a compiler in it is a larger attack surface for no benefit.
#
# The base is Bun's own image rather than a general Debian with Bun installed:
# it is the runtime this application requires, tracked by the people who release
# it, and pinning a minor here is what stops a rebuild in six months picking up
# a Bun that changed something underneath.

FROM oven/bun:1.3 AS build

WORKDIR /app

# Dependencies first, as their own layer. They change far less often than the
# source, so a code change rebuilds in seconds rather than re-resolving the
# whole tree.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Generated artifacts, produced here rather than shipped in the repository or
# generated at boot. At boot is worse than it sounds: it puts a second of work
# and a class of failure into the path of the first request.
RUN bun run --bun ./buddy generate:openapi || true


FROM oven/bun:1.3 AS runtime

# `git` is not optional. Every repository operation shells out to it - that is
# the design, written down in AGENTS.md - so an image without it starts fine and
# fails on the first clone.
#
# `ca-certificates` for outbound https: mirrors, webhooks, and anything fetching
# from another forge.
RUN apt-get update \
  && apt-get install --no-install-recommends -y git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Not root. A process that only needs to read its own code and write two
# directories has no reason to be able to write the rest of the filesystem, and
# `bun` is the unprivileged user the base image already provides.
COPY --from=build --chown=bun:bun /app /app

USER bun

# The two paths that hold state, and the only two. Everything else in this image
# is reproducible from the source.
#
#   /app/storage/repos  - the bare git repositories. Losing this loses the code.
#   /app/storage/app    - uploads and attachments.
#
# Declared so a `docker run` with no volumes still keeps them across a restart,
# and so `docker inspect` tells an operator what to back up. See
# docs/self-hosting.md, which says the same thing in prose.
VOLUME ["/app/storage/repos", "/app/storage/app"]

ENV NODE_ENV=production
ENV APP_ENV=production

EXPOSE 3000

# Checked from inside the container, because that is the only place that can
# tell "the process is wedged" from "the network in front of it is". `quick=1`
# skips the disk write: this runs every thirty seconds and a liveness probe does
# not need to prove the volume is writable that often.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/api/health?quick=1'); process.exit(r.ok ? 0 : 1)"

# The web process. The queue worker runs the same image with a different command
# - see compose.yaml - because they scale and fail independently: a stuck job
# should not stop anybody reading a diff.
CMD ["bun", "run", "--bun", "./buddy", "serve"]
