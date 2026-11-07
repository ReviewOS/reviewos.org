import { expect, test } from 'bun:test'
import { objectStorageRuntimeEnvironment } from '../../cloud/object-storage'

test('production deployments keep their durable store and required push recovery across future releases', () => {
  for (const mode of ['prod', 'production']) {
    expect(objectStorageRuntimeEnvironment(mode)).toEqual({ BLOB_S3_BUCKET: 'reviewos-production', GIT_WAL: 'required' })
    expect(objectStorageRuntimeEnvironment(mode, { bucket: 'another-environment', wal: 'off' })).toEqual({ BLOB_S3_BUCKET: 'reviewos-production', GIT_WAL: 'required' })
  }
})

test('other environments cannot acquire the production object store by default', () => {
  for (const mode of ['', 'local', 'test', 'staging', 'stage', 'dev', 'development']) {
    expect(objectStorageRuntimeEnvironment(mode)).toEqual({ BLOB_S3_BUCKET: '', GIT_WAL: 'off' })
    expect(objectStorageRuntimeEnvironment(mode, { bucket: 'isolated-fixture', wal: 'advisory' })).toEqual({ BLOB_S3_BUCKET: 'isolated-fixture', GIT_WAL: 'advisory' })
  }
})
