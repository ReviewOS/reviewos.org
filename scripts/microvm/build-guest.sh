#!/usr/bin/env bash
# Build the two artifacts a microVM job needs: a kernel and a root filesystem.
#
# `docs/ci-execution-plane.md` listed this as the gap it had not closed - "no
# image build pipeline. What an image must contain ... is written here and
# enforced nowhere" - and the cost of the gap was that
# `tests/e2e/microvm-egress.test.ts` ran on nobody's machine. Five tests that
# assert a stranger's workflow cannot reach the cloud metadata endpoint or the
# host holding every private repository, standing down on every run.
#
#   ./scripts/microvm/build-guest.sh
#   eval "$(./scripts/microvm/build-guest.sh --env)"   # and export the result
#
# Linux only, because it writes an ext4 filesystem. It needs no root: see the
# note on mke2fs below.
set -euo pipefail

# ---------------------------------------------------------------------------
# What is pinned, and why it is pinned here rather than resolved at build time
#
# Firecracker's own getting-started resolves "the latest kernel in our CI" by
# listing an S3 bucket. That is the right default for a tutorial and the wrong
# one for this: `config/ci-execution.ts` refuses to run a job without
# `REVIEWOS_GUEST_IMAGE_DIGEST`, deliberately, because "a run has to be able to
# record what executed it". A build that silently picks up a different kernel
# next Tuesday produces a recorded digest that means nothing.
#
# So both inputs are named by version and checked by hash. Moving to a newer
# kernel is an edit here, with the new hash, which is exactly the visibility
# the pinning exists for.
# ---------------------------------------------------------------------------

KERNEL_VERSION="6.1.155"
KERNEL_CI="v1.14"
ALPINE_VERSION="3.24.2"
ALPINE_SERIES="v3.24"

sha_for() {
  case "$1" in
    kernel-x86_64) echo e41c7048bd2475e7e788153823fcb9166a7e0b78c4c443bd6446d015fa735f53 ;;
    kernel-aarch64) echo 61baeae1ac6197be4fc5c71fa78df266acdc33c54570290d2f611c2b42c105be ;;
    alpine-x86_64) echo c5ca053cfe1d85c5b96dff8b9bc57045f7f184a30ffb6b65776409ca90388677 ;;
    alpine-aarch64) echo 9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773 ;;
    *) return 1 ;;
  esac
}

ARCH="${REVIEWOS_GUEST_ARCH:-$(uname -m)}"
OUT="${REVIEWOS_GUEST_OUT:-storage/framework/runtime/microvm}"
EMIT_ENV=0

for argument in "$@"; do
  case "$argument" in
    --env) EMIT_ENV=1 ;;
    --out=*) OUT="${argument#--out=}" ;;
    --arch=*) ARCH="${argument#--arch=}" ;;
    *) echo "unknown argument: $argument" >&2; exit 2 ;;
  esac
done

case "$ARCH" in
  x86_64 | amd64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *) echo "no pinned artifacts for $ARCH" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# Only the `--env` block is allowed to reach stdout
#
# Because that block is meant to be eval'd, and anything else landing on the
# same stream is eval'd with it. `mke2fs -q` is quieter than `mke2fs` and is not
# silent - it still announces "Creating filesystem with 16384 4k blocks" - so
# the first run of this in CI eval'd that sentence and died with
# "Creating: command not found".
#
# Suppressing that one command's output would fix that one command. Moving the
# whole script's stdout to stderr and handing the env block the real one fixes
# the class, including the next tool that decides to say something.
# ---------------------------------------------------------------------------

exec 3>&1
exec 1>&2

say() { echo "[guest] $*"; }

verify() {
  local file="$1" want="$2" got
  got=$(sha256sum "$file" | cut -d' ' -f1)

  if [ "$got" != "$want" ]; then
    echo "$file does not match its pinned digest" >&2
    echo "  expected $want" >&2
    echo "  actually $got" >&2
    exit 1
  fi
}

mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# The kernel
#
# Taken from Firecracker's published CI artifacts rather than built from
# source. A guest kernel has to be configured for this hypervisor's device
# model - virtio-mmio, no ACPI on the no-acpi variants, a serial console - and
# an upstream defconfig boots into a panic on all three. Firecracker publishes
# the configuration beside the kernel, so building from source later is a
# change of method rather than a change of contract: the digest is what the run
# records either way.
# ---------------------------------------------------------------------------

KERNEL="$OUT/vmlinux-$KERNEL_VERSION-$ARCH"

if [ -f "$KERNEL" ] && [ "$(sha256sum "$KERNEL" | cut -d' ' -f1)" = "$(sha_for "kernel-$ARCH")" ]; then
  say "kernel already here and matching: $KERNEL"
else
  say "fetching kernel $KERNEL_VERSION for $ARCH"
  curl -fsSL -o "$KERNEL.partial" \
    "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/$KERNEL_CI/$ARCH/vmlinux-$KERNEL_VERSION"
  verify "$KERNEL.partial" "$(sha_for "kernel-$ARCH")"
  mv "$KERNEL.partial" "$KERNEL"
fi

# ---------------------------------------------------------------------------
# The root filesystem
#
# Alpine's minirootfs, which is busybox and almost nothing else. Every program
# the agent runs is already in it - `mount`, `stty`, `ip`, `base64`, `wc`,
# `head`, `poweroff` - and so is the `wget` the egress tests use to try to
# reach somewhere they should not. So there is no chroot and no package
# install in this script, and therefore no network access beyond the two
# downloads above: the image is a tarball plus one file.
#
# That one file is the agent, and it is not written here. `write-agent.ts`
# takes it from `guestAgent()` in `microvmProtocol.ts`, where the host's own
# frame parser lives, so the image cannot drift from the protocol the host
# reads. An image built with a stale agent is the failure this arrangement
# exists to make impossible.
# ---------------------------------------------------------------------------

TARBALL="$WORK/alpine.tar.gz"
say "fetching alpine $ALPINE_VERSION minirootfs for $ARCH"
curl -fsSL -o "$TARBALL" \
  "https://dl-cdn.alpinelinux.org/alpine/$ALPINE_SERIES/releases/$ARCH/alpine-minirootfs-$ALPINE_VERSION-$ARCH.tar.gz"
verify "$TARBALL" "$(sha_for "alpine-$ARCH")"

TREE="$WORK/tree"
mkdir -p "$TREE"
tar xzf "$TARBALL" -C "$TREE"

# The mount points, which have to exist in the image because the agent cannot
# create them: the root filesystem is mounted read-only and stays that way, so
# that one job cannot change what the next job boots.
mkdir -p "$TREE/proc" "$TREE/sys" "$TREE/tmp" "$TREE/work" "$TREE/work/workspace"

# `/dev` is deliberately left empty, and that is worth a sentence because it
# looks like an omission. The agent reads `/dev/console` and mounts `/dev/vdb`,
# neither of which is in Alpine's tarball - it ships no device nodes at all,
# which is also what keeps this build rootless. The kernel supplies them:
# Firecracker's published config has `CONFIG_DEVTMPFS_MOUNT=y`, so devtmpfs is
# mounted on /dev before init is executed. Checked against the config beside
# the kernel rather than assumed, along with VIRTIO_BLK for the two disks,
# EXT4_FS for both of them, SERIAL_8250_CONSOLE for ttyS0 and TMPFS for the
# agent's /tmp.

bun scripts/microvm/write-agent.ts "$TREE/sbin/reviewos-agent"
chmod 0755 "$TREE/sbin/reviewos-agent"

# ---------------------------------------------------------------------------
# And the image, built without root
#
# `mke2fs -d` populates a filesystem from a directory. The obvious alternative
# - make an empty image, `mount -o loop`, copy, unmount - needs privilege for
# the mount, which would put sudo on the path of every developer who wants to
# run these tests once. `-d` needs none, so this script is one an ordinary user
# can run and the privileged surface stays where `microvmSupervisor.ts` already
# documents it: the payload disk, the tap device and the filter.
#
# 64MiB against a tree of about 9MiB. The slack is for an operator who adds a
# toolchain to this image, which is the expected thing to do with it, and the
# file is sparse so the unused part costs nothing on disk.
# ---------------------------------------------------------------------------

ROOTFS="$OUT/rootfs-$ALPINE_VERSION-$ARCH.ext4"

rm -f "$ROOTFS"
mke2fs -q -t ext4 -d "$TREE" -b 4096 -L reviewos-guest "$ROOTFS" 16384

KERNEL_DIGEST=$(sha256sum "$KERNEL" | cut -d' ' -f1)
IMAGE_DIGEST=$(sha256sum "$ROOTFS" | cut -d' ' -f1)

say "kernel $KERNEL"
say "  sha256 $KERNEL_DIGEST"
say "image  $ROOTFS"
say "  sha256 $IMAGE_DIGEST"

if [ "$EMIT_ENV" = 1 ]; then
  # Absolute, because a job's supervisor does not run in this directory. On fd
  # 3, which is the stdout this script set aside at the top.
  cat >&3 <<ENV
export REVIEWOS_GUEST_KERNEL=$(realpath "$KERNEL")
export REVIEWOS_GUEST_KERNEL_DIGEST=$KERNEL_DIGEST
export REVIEWOS_GUEST_IMAGE=$(realpath "$ROOTFS")
export REVIEWOS_GUEST_IMAGE_DIGEST=$IMAGE_DIGEST
ENV
fi
