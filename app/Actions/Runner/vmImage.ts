/**
 * Which image a job booted, and what the run is allowed to say about it.
 *
 * The roadmap asks for two things in one line - *"runner images and toolchains
 * are pinned and attestable. A run records exactly what executed it."* - and
 * they are different claims with very different strengths. Keeping them apart is
 * most of what this file is for.
 *
 * **Pinned** is achievable here and is a property of the reference: an image is
 * named by digest, so the bytes that boot are the bytes the operator chose. A
 * tag is not a pin. `base:latest` is a name somebody can move afterwards, and an
 * image reference that can change under a run is not a record of anything.
 *
 * **Attested** - proof the instance can check - is not achievable in software,
 * and saying so is the point. Any measurement a runner reports could be forged by
 * a runner that wanted to, and the threat model treats a runner as
 * compromised-by-design. Closing that needs a root of trust the runner cannot
 * lie through: a TPM quote, an SEV-SNP or TDX report. It is hardware, not code.
 *
 * ## The middle level, which is achievable and was missing
 *
 * Between "the operator typed a digest" and "the hardware signed a measurement"
 * there is a third thing: **the runner hashes the bytes it is about to boot and
 * refuses if they are not the ones that were pinned.**
 *
 * That does not stop a runner lying. It stops the failure that actually happens,
 * which is nobody lying at all: an image rebuilt in place, a path pointing at
 * last month's file, a digest copied from the wrong line of a build log. Before
 * this, a runner could boot one image and report another and nothing anywhere
 * would notice - the digest was a string in a configuration file that was never
 * compared to anything.
 *
 * So `provenance` has three values and each one means what it says. `asserted` is
 * a digest nobody checked; `measured` is one this runner computed from the bytes
 * it read; `attested` is reserved for hardware and is not produced by any code
 * here. The field exists at three levels so that adding the third later does not
 * silently change the meaning of rows written under the first two.
 */

/** An image an operator has made available to their runners. */
export interface ImageManifest {
  /** A human name, for the screen. Never used to decide what boots. */
  name: string
  /** `sha256:...`, which is what actually decides. */
  digest: string
  /** The guest kernel this image is built against, also by digest. */
  kernelDigest: string
  /** What is installed, so a workflow can say what it needs and be told. */
  toolchains: Readonly<Record<string, string>>
  /** When the operator built it. ISO 8601. */
  builtAt: string
}

/** What is written against the run, and what it is worth. */
export interface ExecutionRecord {
  imageName: string
  imageDigest: string
  kernelDigest: string
  toolchains: Readonly<Record<string, string>>
  /**
   * How this was established, and it is never more than the truth.
   *
   * A reader deciding whether to trust a build needs to know which of three
   * things happened: nobody checked, this runner hashed the bytes, or hardware
   * signed a measurement. Collapsing them into a boolean is how the weakest one
   * gets read as the strongest.
   */
  provenance: Provenance
}

/**
 * How well the instance knows what ran.
 *
 * Ordered, and the order is the point: a reader can ask "is this at least
 * measured" without knowing every value that will ever exist.
 */
export type Provenance = 'asserted' | 'measured' | 'attested'

export const PROVENANCE_ORDER: readonly Provenance[] = ['asserted', 'measured', 'attested']

const DIGEST = /^sha256:[0-9a-f]{64}$/

/**
 * Why this reference may not be booted, or null when it may.
 *
 * Every refusal here is about the reference being *stable*. An image that can
 * change under a run makes the record meaningless, and the record is the only
 * thing this phase actually delivers.
 */
export function refusalForImage(reference: string): string | null {
  const cleaned = String(reference ?? '').trim().toLowerCase()

  if (!cleaned)
    return 'an image has to be named'

  if (DIGEST.test(cleaned))
    return null

  /*
   * Named specifically rather than lumped in with "not a digest", because these
   * are the two an operator actually types and the generic message would leave
   * them guessing which half was wrong.
   */
  if (cleaned === 'latest' || cleaned.endsWith(':latest'))
    return 'a moving tag is not a pin: `latest` is a name somebody can point somewhere else after this run recorded it'

  if (cleaned.includes(':'))
    return 'a tag is not a pin - name the image by its `sha256:` digest, which cannot be moved'

  return 'an image has to be named by its `sha256:` digest'
}

/** Whether a manifest is one this runner may boot. */
export function refusalForManifest(manifest: ImageManifest): string | null {
  const image = refusalForImage(manifest?.digest ?? '')

  if (image)
    return image

  /*
   * The kernel is pinned too, and separately.
   *
   * A microVM boots a kernel the *host* supplies, not one inside the image - so
   * an image digest says nothing about the kernel that ran. Two runs on the same
   * image and different kernels are two different machines, and the one that
   * matters is usually the kernel.
   */
  if (!DIGEST.test(String(manifest?.kernelDigest ?? '').trim().toLowerCase()))
    return 'the guest kernel has to be pinned by digest too - an image digest says nothing about the kernel the host booted it with'

  return null
}

/**
 * What the run records.
 *
 * `asserted` unless a caller has measured, which is why the parameter has that
 * default: a record whose provenance was optimistic by accident would be the one
 * failure this whole distinction exists to prevent.
 */
export function executionRecord(manifest: ImageManifest, provenance: Provenance = 'asserted'): ExecutionRecord {
  return {
    imageName: String(manifest?.name ?? '').slice(0, 200),
    imageDigest: String(manifest?.digest ?? '').toLowerCase(),
    kernelDigest: String(manifest?.kernelDigest ?? '').toLowerCase(),
    toolchains: { ...(manifest?.toolchains ?? {}) },
    provenance,
  }
}

/**
 * The digest of a file this runner is about to boot.
 *
 * Streamed rather than read, for the reason `digestOfFile` in `snapshot.ts` is:
 * an image is a gigabyte and this process is also supervising somebody's build.
 *
 * **Memoised on identity rather than path**, because the cost is the point of the
 * memo and the risk is staleness. A path alone would keep answering about an
 * image that has since been rebuilt underneath it - which is one of the two
 * failures this whole function exists to catch - so the key carries size and
 * modification time, and a rebuilt file measures again.
 */
const measured = new Map<string, string>()

export async function measureFile(path: string): Promise<string | null> {
  const file = Bun.file(path)

  if (!(await file.exists()))
    return null

  const key = `${path}:${file.size}:${file.lastModified}`
  const remembered = measured.get(key)

  if (remembered)
    return remembered

  const hasher = new Bun.CryptoHasher('sha256')

  for await (const chunk of file.stream())
    hasher.update(chunk)

  const digest = `sha256:${hasher.digest('hex')}`

  measured.set(key, digest)

  return digest
}

/** Forget what has been measured. For tests, and for a runner told to re-read. */
export function forgetMeasurements(): void {
  measured.clear()
}

/**
 * Check the pinned digests against the bytes on disk.
 *
 * The refusal is the useful half. A machine boots perfectly well from an image
 * nobody named and equally well from one named wrongly, so a mismatch that only
 * produced a warning would produce a run recording a digest that was not what
 * executed it - which is worse than recording nothing, because it is checkable
 * and wrong.
 */
export async function verifyPinned(input: {
  imagePath: string
  imageDigest: string
  kernelPath: string
  kernelDigest: string
}): Promise<{ ok: true, provenance: Provenance } | { ok: false, reason: string }> {
  const image = await measureFile(input.imagePath)

  if (!image)
    return { ok: false, reason: `the guest image is not readable at \`${input.imagePath}\`` }

  if (image !== String(input.imageDigest ?? '').trim().toLowerCase()) {
    return {
      ok: false,
      reason: `the guest image at \`${input.imagePath}\` is \`${image}\`, not the \`${input.imageDigest}\` this runner was told to boot. An image was rebuilt or a digest was copied from the wrong place; either way a run would record something that did not execute it.`,
    }
  }

  const kernel = await measureFile(input.kernelPath)

  if (!kernel)
    return { ok: false, reason: `the guest kernel is not readable at \`${input.kernelPath}\`` }

  /*
   * The kernel is checked separately and its absence from configuration is
   * tolerated, which the image's is not. A microVM boots a kernel the *host*
   * supplies, so an operator who pinned only the image has pinned half of what
   * ran - worth saying, not worth refusing over, because the image digest is
   * still the one that decides what the job could see.
   */
  if (input.kernelDigest && kernel !== String(input.kernelDigest).trim().toLowerCase()) {
    return {
      ok: false,
      reason: `the guest kernel at \`${input.kernelPath}\` is \`${kernel}\`, not the \`${input.kernelDigest}\` this runner was told to boot.`,
    }
  }

  return { ok: true, provenance: 'measured' }
}

/**
 * Whether an image satisfies what a workflow asked for.
 *
 * Exact versions, not ranges. A workflow that says `bun: 1.3.14` and gets 1.3.15
 * has been given something it did not ask for, and the entire reason to pin an
 * image is that "close enough" is what produces a build that passes here and
 * fails somewhere else.
 */
export function missingToolchains(
  manifest: ImageManifest,
  wanted: Readonly<Record<string, string>>,
): { name: string, wanted: string, found: string | null }[] {
  const missing: { name: string, wanted: string, found: string | null }[] = []

  for (const [name, version] of Object.entries(wanted ?? {})) {
    const found = manifest?.toolchains?.[name] ?? null

    if (found !== String(version))
      missing.push({ name, wanted: String(version), found })
  }

  return missing
}
