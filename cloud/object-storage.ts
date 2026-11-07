/** Durable application objects, isolated from the off-host backup bucket. */
export const reviewosObjectStorage = {
  provider: 'hetzner' as const,
  region: 'hel1',
  bucket: 'reviewos-production',
  prefix: 'reviewos',
  versioning: true,
  credentialsFile: '/var/www/reviewos-shared/credentials/object-storage.json',
}

/** Production durability is declared here; other environments use their own store. */
export function objectStorageRuntimeEnvironment(environment: string, overrides: { bucket?: string, wal?: string } = {}) {
  const production = environment === 'production' || environment === 'prod'
  return {
    BLOB_S3_BUCKET: production ? reviewosObjectStorage.bucket : String(overrides.bucket || ''),
    GIT_WAL: production ? 'required' : String(overrides.wal || 'off'),
  }
}
