/**
 * The guest agent, out of the source and onto disk.
 *
 * `guestAgent()` in `app/Actions/Runner/microvmProtocol.ts` is the agent, and
 * its own comment says why it lives there rather than in a file: it belongs to
 * the *image*, which an operator builds and pins by digest, so a host that
 * could hand a guest its agent at boot would be a host that could change the
 * guest's behaviour after the image was pinned.
 *
 * That left the two ends unconnected. The source said what an image must
 * contain and nothing turned it into one, which `docs/ci-execution-plane.md`
 * recorded as "written here and enforced nowhere". This is the bridge, and it
 * is deliberately the only one: `build-guest.sh` never writes the agent itself,
 * it asks for it here, so the image cannot drift from the protocol the host
 * parses.
 */

import { guestAgent } from '../../app/Actions/Runner/microvmProtocol'

const target = process.argv[2]

if (!target) {
  process.stdout.write(guestAgent())
}
else {
  await Bun.write(target, guestAgent())
  // Readable, executable, and owned by nobody in particular: the image is
  // mounted read-only, so this is the last moment the bit can be set.
  await Bun.$`chmod 0755 ${target}`.quiet()
}
