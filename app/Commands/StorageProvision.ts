import type { CLI } from '@stacksjs/types'
import { readFile } from 'node:fs/promises'
import { createObjectStorageClient } from '@stacksjs/ts-cloud'
import { reviewosObjectStorage as storage } from '../../cloud/object-storage'

export default function (cli: CLI) {
  cli.command('storage:provision', 'Check or create private, versioned application object storage')
    .option('--apply', 'Create the declared bucket and enable versioning')
    .action(async (options: { apply?: boolean }) => {
      const credentials = JSON.parse(await readFile(storage.credentialsFile, 'utf8'))
      const client = createObjectStorageClient({ provider: storage.provider, region: storage.region, credentials })
      const owned = (await client.listBuckets()).Buckets.some(bucket => bucket.Name === storage.bucket)
      if (!owned && options.apply) await client.createBucket(storage.bucket, { acl: 'private' })
      if (options.apply) await client.putBucketVersioning(storage.bucket, 'Enabled')
      const versioning = owned || options.apply ? await client.getBucketVersioning(storage.bucket) : null
      console.log(JSON.stringify({ bucket: storage.bucket, region: storage.region, owned: owned || !!options.apply, versioning }))
      if (options.apply && versioning?.Status !== 'Enabled') throw new Error('Object storage versioning did not become enabled')
    })
}
