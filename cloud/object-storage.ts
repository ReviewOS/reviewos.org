/** Durable application objects, isolated from the off-host backup bucket. */
export const reviewosObjectStorage = {
  provider: 'hetzner' as const,
  region: 'hel1',
  bucket: 'reviewos-production',
  prefix: 'reviewos',
  versioning: true,
  credentialsFile: '/var/www/reviewos-shared/credentials/object-storage.json',
}
