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
 * **Attestable** is not achievable here, and saying so is the point. Recording a
 * digest proves what this runner *said* it booted. Proving what it *did* boot
 * needs a measurement the runner cannot forge - a TPM quote, a signed launch
 * measurement - which needs the hypervisor and the hardware, and belongs to
 * phase B. `docs/ci-security-review.md` already says the honest version of this:
 * *"Nothing verifies what executed a run. `Runner` records a name and labels the
 * machine asserted."* This file narrows that gap and does not close it.
 *
 * So the record below is deliberately called what it is. It is an assertion by
 * the runner, stored so that a later question - "which image was this built on,
 * and is that the one we thought" - has an answer to check rather than nothing
 * to check.
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
   * How this was established.
   *
   * `asserted` is the only value this phase can produce, and it exists so that
   * `measured` can be added later without every reader silently upgrading the
   * meaning of the rows written before it. A column that changes meaning is
   * worse than a column that admits it was always weak.
   */
  provenance: 'asserted' | 'measured'
}

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
 * Marked `asserted`, always, in this phase. The runner is telling the instance
 * what it booted and the instance has no way to check - which is exactly the
 * sentence `docs/ci-security-review.md` uses, and the reason this returns a
 * provenance rather than an unqualified fact.
 */
export function executionRecord(manifest: ImageManifest): ExecutionRecord {
  return {
    imageName: String(manifest?.name ?? '').slice(0, 200),
    imageDigest: String(manifest?.digest ?? '').toLowerCase(),
    kernelDigest: String(manifest?.kernelDigest ?? '').toLowerCase(),
    toolchains: { ...(manifest?.toolchains ?? {}) },
    provenance: 'asserted',
  }
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
