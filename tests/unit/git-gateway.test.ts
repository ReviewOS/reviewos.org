import { describe, expect, test } from 'bun:test'
import { buildHostRoutes, createProxyFetchHandler, createUpstreamPool, matchHostRoute } from '@stacksjs/rpx'
import { resolveSiteKind, shipsARelease } from '@stacksjs/ts-cloud'
import { buildRpxConfig } from '@stacksjs/ts-cloud/drivers'
import { tsCloud } from '../../config/cloud'

const gateway = buildRpxConfig(tsCloud.sites!, { proxy: {}, slug: tsCloud.project.slug })
const gitSite = tsCloud.sites!.git!
const gitRoute = gateway.proxies.find(route => route.to === gitSite.domain && route.path === '/git')!

describe('Git gateway availability', () => {
  test('the deployed Git mount goes straight to the existing API without another release', () => {
    expect(resolveSiteKind(gitSite)).toBe('proxy')
    expect(shipsARelease(gitSite)).toBe(false)
    expect(gitRoute.from).toBe(`127.0.0.1:${tsCloud.sites!.api!.port}`)
    expect(gitRoute.auth).toBeUndefined()

    const table = buildHostRoutes(gateway.proxies.map(route => ({ host: route.to, path: route.path, route })))
    for (const path of ['/git/owner/repository.git/info/refs', '/git/owner/repository.git/git-upload-pack', '/git/owner/repository.git/git-receive-pack'])
      expect(matchHostRoute(table, gitSite.domain!, path)).toBe(gitRoute)
    expect(matchHostRoute(table, gitSite.domain!, '/github')).not.toBe(gitRoute)
    expect(matchHostRoute(table, gitSite.domain!, '/owner/repository')).not.toBe(gitRoute)
  })

  test('API authentication, paths and streaming survive a stopped page server', async () => {
    let pageRequests = 0
    const page = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
      pageRequests += 1
      return new Response('page')
    } })
    let continuePack: (() => void) | undefined
    const paused = new Promise<void>((resolve) => { continuePack = resolve })
    const seen: Array<{ method: string, path: string, body: string }> = []
    const api = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
      if (request.headers.get('authorization') !== 'Basic dGVzdDpwYXRfb25seQ==')
        return new Response('authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Git"' } })
      const url = new URL(request.url)
      seen.push({ method: request.method, path: url.pathname + url.search, body: await request.text() })
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(new TextEncoder().encode('first-pack-chunk'))
        await paused
        controller.enqueue(new TextEncoder().encode('last-pack-chunk'))
        controller.close()
      } }), { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } })
    } })
    // Use the published gateway's route matcher and streaming proxy, changing
    // only the two upstream ports to these isolated test servers.
    const table = buildHostRoutes(gateway.proxies.map(route => ({
      host: route.to,
      path: route.path,
      route: { upstreamPool: createUpstreamPool(route === gitRoute ? `127.0.0.1:${api.port}` : `127.0.0.1:${page.port}`) },
    })))
    const proxy = createProxyFetchHandler((host, path) => matchHostRoute(table, host, path))
    const url = `http://${gitSite.domain}/git/owner/repository.git/git-upload-pack?service=git-upload-pack`
    try {
      const denied = (await proxy(new Request(url, { headers: { Host: gitSite.domain! } })))!
      expect(denied.status).toBe(401)
      expect(denied.headers.get('www-authenticate')).toBe('Basic realm="Git"')
      expect(await denied.text()).toBe('authentication required')
      const response = (await proxy(new Request(url, {
        method: 'POST',
        headers: { Host: gitSite.domain!, Authorization: 'Basic dGVzdDpwYXRfb25seQ==', 'Content-Type': 'application/x-git-upload-pack-request' },
        body: 'want fixture-object\n',
      })))!
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/x-git-upload-pack-result')
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first-pack-chunk')
      await page.stop(true)
      continuePack!()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('last-pack-chunk')
      expect((await reader.read()).done).toBe(true)
      expect(seen).toEqual([{ method: 'POST', path: '/git/owner/repository.git/git-upload-pack?service=git-upload-pack', body: 'want fixture-object\n' }])
      expect(pageRequests).toBe(0)
    }
    finally {
      continuePack!()
      await api.stop(true)
      await page.stop(true)
    }
  })
})
