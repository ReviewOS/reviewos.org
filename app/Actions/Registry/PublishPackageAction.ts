import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import registryConfig from '../../../config/registry'
import { coerced } from '../inputs'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult, ForgeError } from '../Support/forge'
import { claimPackage, packageName, packageVersion, pantryJson, registryConfigured } from './pantry'

export default new Action({
  name: 'PublishPackage', method: 'POST', description: 'Publish a package version through the native Pantry registry',
  validations: { metadata: { rule: coerced }, name: { rule: schema.string() }, version: { rule: schema.string() }, description: { rule: schema.string() }, license: { rule: schema.string() } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'package:publish')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      if (!registryConfigured())
        throw new ForgeError('The package registry has not been configured by this instance administrator', 503)
      let metadata: any = request.get('metadata')
      if (typeof metadata === 'string') {
        if (metadata.length > 64_000)
          throw new ForgeError('Package metadata is too large', 413)
        try { metadata = JSON.parse(metadata) }
        catch { throw new ForgeError('Package metadata must be valid JSON') }
      }
      metadata ??= { name: request.get('name'), version: request.get('version'), description: request.get('description'), license: request.get('license') }
      const name = packageName(metadata?.name)
      const owner = String(request.getParam('owner')).toLowerCase()
      if (!name.startsWith(`@${owner}/`))
        throw new ForgeError('The package scope must match this repository owner', 403)
      const version = packageVersion(metadata?.version)
      const file = request.file('tarball')
      if (!file || file.size === 0)
        throw new ForgeError('Upload a package tarball')
      if (file.size > registryConfig.maxUploadBytes)
        throw new ForgeError('Package tarballs may be up to 50 MB', 413)
      const service = await pantryJson('/api/registry-info')
      if (service.visibility !== 'private' || service.requiresAuth !== true || service.npmFallback !== false)
        throw new ForgeError('Configure a private Pantry registry with npm fallback disabled before publishing.', 503)
      const form = new FormData()
      form.set('metadata', JSON.stringify({ ...metadata, name, version }))
      form.set('tarball', new Blob([await file.arrayBuffer()]), `${name.split('/')[1]}-${version}.tgz`)
      await claimPackage(Number(auth.context.repository.id), name)
      const published = await pantryJson('/publish', { method: 'POST', body: form })
      return forgeResult(request, { ...published, name, version }, `/${owner}/${auth.context.repository.name}/packages?name=${encodeURIComponent(name)}`, 201)
    })
  },
})
