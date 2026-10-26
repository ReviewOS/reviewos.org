/** A private Pantry registry service, reachable only by the forge. */
export default {
  url: process.env.REVIEWOS_REGISTRY_URL ?? '',
  token: process.env.REVIEWOS_REGISTRY_TOKEN ?? '',
  maxUploadBytes: 50 * 1024 * 1024,
}
