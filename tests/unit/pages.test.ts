// Publishing a site, and the three places somebody else's bytes decide what
// this instance does with them.
//
// The archive is produced by a build of somebody's repository, the URL is typed
// by a stranger, and the host is a header. Each of those is attacker-controlled,
// and the tests below are the rules that make them safe rather than a
// description of how the code happens to work.

import { describe, expect, test } from 'bun:test'
import { buildTar } from '../../app/Actions/Artifact/tar'
import { isSafeEntryName, maybeGunzip, untar } from '../../app/Actions/Pages/untar'
import { contentTypeFor, resolveSitePath } from '../../app/Actions/Pages/site'
import { normalizeHost, parsePagesRequest } from '../../app/Actions/Pages/host'
import { branchOfRef } from '../../app/Actions/Pages/publish'
import { STARTERS } from '../../app/Actions/Workflow/templates'

function entry(name: string, text: string) {
  return { name, bytes: new TextEncoder().encode(text) }
}

describe('reading the archive', () => {
  test('round-trips what the writer produced', () => {
    const archive = buildTar([entry('index.html', '<h1>hi</h1>'), entry('guide/index.html', 'guide')])
    const { files, error } = untar(archive)

    expect(error).toBeUndefined()
    expect(files.map(file => file.name)).toEqual(['index.html', 'guide/index.html'])
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe('<h1>hi</h1>')
  })

  test('accepts the `./` prefix `tar -C dist .` writes', () => {
    // Refusing it would refuse the archive every real workflow produces.
    const { files } = untar(buildTar([entry('./index.html', 'page')]))

    expect(files.map(file => file.name)).toEqual(['index.html'])
  })

  test('ungzips when the bytes are gzipped, and passes them through when they are not', () => {
    const plain = buildTar([entry('index.html', 'page')])
    const gzipped = Bun.gzipSync(plain)

    expect(untar(maybeGunzip(gzipped)).files).toHaveLength(1)
    expect(untar(maybeGunzip(plain)).files).toHaveLength(1)
  })

  test('refuses an entry that claims to be larger than the archive', () => {
    // The size in a header is a claim. Believing one is how a reader is made to
    // allocate until the process dies.
    const archive = buildTar([entry('index.html', 'page')])
    // Overwrite the size field with something enormous.
    const forged = new Uint8Array(archive)
    forged.set(new TextEncoder().encode('77777777777 '), 124)

    expect(untar(forged).error).toContain('larger than the archive')
  })
})

describe('an entry name is a name, never a path', () => {
  test('refuses traversal, absolute paths and drive letters', () => {
    expect(isSafeEntryName('index.html')).toBe(true)
    expect(isSafeEntryName('guide/index.html')).toBe(true)

    expect(isSafeEntryName('../etc/passwd')).toBe(false)
    expect(isSafeEntryName('a/../../etc/passwd')).toBe(false)
    expect(isSafeEntryName('/etc/passwd')).toBe(false)
    expect(isSafeEntryName('C:\\windows\\system32')).toBe(false)
    expect(isSafeEntryName('a\0b')).toBe(false)
  })

  test('and the extractor drops them rather than writing them', () => {
    const { files } = untar(buildTar([entry('../escape.html', 'no'), entry('index.html', 'yes')]))

    expect(files.map(file => file.name)).toEqual(['index.html'])
  })
})

describe('a URL becomes a file', () => {
  test('a directory gets its index', () => {
    // Every static site generator writes `guide/index.html`, and every link in
    // the site it generated points at `/guide/`.
    expect(resolveSitePath('/')).toBe('index.html')
    expect(resolveSitePath('/guide/')).toBe('guide/index.html')
    expect(resolveSitePath('/guide')).toBe('guide/index.html')
  })

  test('a file is served as itself', () => {
    expect(resolveSitePath('/assets/app.css')).toBe('assets/app.css')
    expect(resolveSitePath('/favicon.ico')).toBe('favicon.ico')
  })

  test('nothing may leave the site, however it is spelled', () => {
    expect(resolveSitePath('/../../etc/passwd')).toBeNull()
    // Encoded, which is the spelling that gets past a check written on the raw
    // path rather than the decoded one.
    expect(resolveSitePath('/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(resolveSitePath('/a/%00b')).toBeNull()
  })

  test('an unknown extension is not guessed at', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('data.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('script.php')).toBe('application/octet-stream')
  })
})

describe('a host becomes a site', () => {
  const suffix = 'pages.example.com'

  test('strips the port, including from an IPv6 literal', () => {
    expect(normalizeHost('Example.com:3000')).toBe('example.com')
    expect(normalizeHost('[::1]:3000')).toBe('::1')
  })

  test('reads the owner from the subdomain and the repository from the path', () => {
    // Only meaningful when the instance configured a suffix; without one the
    // parser answers null for everything, which is what an instance with Pages
    // off has to do.
    const parsed = parsePagesRequest(`acme.${suffix}`, '/docs/guide/')

    if (!parsed) {
      expect(process.env.PAGES_DOMAIN ?? '').toBe('')
      return
    }

    expect(parsed.owner).toBe('acme')
    expect(parsed.repository).toBe('docs')
    // The trailing slash survives, because it is what tells the resolver this
    // is a directory rather than a file called `guide`.
    expect(parsed.path).toBe('/guide/')
  })

  test('refuses a multi-label owner', () => {
    // `a.b.pages.example.com` is not an owner called `a.b`. Reading it as one
    // would let anybody holding the wildcard certificate invent hosts that
    // resolve to a real owner's site.
    expect(parsePagesRequest(`a.b.${suffix}`, '/docs/')).toBeNull()
  })

  test('and the bare suffix, which belongs to nobody', () => {
    expect(parsePagesRequest(suffix, '/docs/')).toBeNull()
  })
})

describe('what may publish', () => {
  test('a branch ref, and nothing else', () => {
    // A tag or a pull request ref is not a branch, and a site whose address
    // strangers read must not be replaceable by one.
    expect(branchOfRef('refs/heads/main')).toBe('main')
    expect(branchOfRef('refs/heads/release/2.0')).toBe('release/2.0')
    expect(branchOfRef('refs/tags/v1')).toBe('')
    expect(branchOfRef('refs/pull/42/head')).toBe('')
    expect(branchOfRef(null)).toBe('')
  })
})

describe('the Pages starter', () => {
  const starter = STARTERS.find(template => template.id === 'pages')

  test('exists, and lands in this product’s own workflow directory', () => {
    expect(starter).toBeDefined()
    expect(starter!.path).toBe('.reviewos/workflows/pages.yml')
  })

  test('detects a docs folder, a bunpress config, stx, and a committed site', () => {
    const content = starter!.content

    expect(content).toContain('if [ -d docs ]')
    expect(content).toContain('bunpress.config.ts')
    expect(content).toContain('.config/bunpress.ts')
    expect(content).toContain('[ -d pages ] || [ -f index.stx ]')
    expect(content).toContain('[ -f index.html ]')
  })

  test('uploads the one artifact name the publisher reads', () => {
    expect(starter!.content).toContain('name: pages')
    // The contents of the output directory, not the directory itself - the
    // publisher wants index.html at the archive root.
    expect(starter!.content).toContain('tar -czf pages.tar.gz -C dist .')
  })

  test('only publishes from the default branch', () => {
    expect(starter!.content).toContain('branches: [main]')
  })
})
