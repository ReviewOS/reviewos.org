import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

// A normal Linux CI producer, not a local cross-build or an environment dump.
assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'x64')
assert.equal(process.env.GITHUB_ACTIONS, 'true')

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  assert.equal(result.exitCode, 0, 'Cannot bind the runner artifact to its checkout')
  return result.stdout.toString().trim()
}

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')
}

const source = git('rev-parse', 'HEAD')
assert.match(source, /^[a-f0-9]{40}$/)
assert.equal(source, process.env.GITHUB_SHA)
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'The producer checkout changed during the build')

const directory = 'dist/runner/linux-x64'
assert.deepEqual(await readdir(directory), ['reviewos-runner'], 'Upload only the intended binary and generated public provenance')
const binary = join(directory, 'reviewos-runner')
const header = new DataView(await Bun.file(binary).slice(0, 64).arrayBuffer())
assert.equal(header.byteLength, 64)
assert.equal(header.getUint32(0, false), 0x7F454C46)
assert.equal(header.getUint8(4), 2)
assert.equal(header.getUint8(5), 1)
assert.equal(header.getUint16(18, true), 62)

const graph: Record<string, string> = {}
for (const name of ['stacks', '@stacksjs/buddy', '@stacksjs/storage', '@stacksjs/validation', '@stacksjs/cli', '@stacksjs/types', '@stacksjs/stx', '@stacksjs/ts-cloud']) {
  const metadata = await Bun.file(join('node_modules', name, 'package.json')).json()
  assert.equal(metadata.name, name)
  assert.equal(typeof metadata.version, 'string')
  graph[name] = metadata.version
}

const buildCommand = await Bun.file('app/Commands/BuildRunner.ts').text()
assert(buildCommand.includes('--no-compile-autoload-dotenv'))
assert(buildCommand.includes('--no-compile-autoload-bunfig'))
const binarySha256 = await sha256(binary)
const proof = {
  schema_version: 1,
  source,
  source_tree: git('rev-parse', 'HEAD^{tree}'),
  workflow_run_id: process.env.GITHUB_RUN_ID,
  workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  event: process.env.GITHUB_EVENT_NAME,
  ref: process.env.GITHUB_REF,
  bun: Bun.version,
  target: 'bun-linux-x64',
  installed_versions: graph,
  inputs: {
    package_json: await sha256('package.json'),
    bun_lock: await sha256('bun.lock'),
    entrypoint: await sha256('app/Actions/Runner/standalone.ts'),
    limits: await sha256('app/Actions/Runner/limits.ts'),
    build_command: await sha256('app/Commands/BuildRunner.ts'),
    workflow: await sha256('.github/workflows/ci.yml'),
  },
  binary: { name: 'reviewos-runner', bytes: Bun.file(binary).size, sha256: binarySha256, format: 'ELF64', architecture: 'x64' },
  compile_autoload: { dotenv: false, bunfig: false },
}
await Bun.write(join(directory, 'provenance.json'), `${JSON.stringify(proof, null, 2)}\n`)
await Bun.write(join(directory, 'checksums.sha256'), `${binarySha256}  reviewos-runner\n`)
console.log(`Recorded Linux runner ${binarySha256} from ${source}`)
