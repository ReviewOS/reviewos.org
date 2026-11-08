import { expect, test } from 'bun:test'

// Repository source and discussion text can contain directive examples. Run
// the installed parser in a child: an infinite synchronous scan would block
// the test runner's own timeout as well as the production page event loop.
for (const [module, entry] of [
  ['component-renderer', 'processComponents'],
  ['component-processing', 'processComponentDirectives'],
] as const) {
  test(`${module} finishes malformed component examples without changing their text`, async () => {
    const template = `${'Repository documentation '.repeat(4000)}@component() @component(path) @component('')`
    const args = entry === 'processComponents'
      ? `${JSON.stringify(template)}, {}, '/tmp/reviewos-component-example.stx', {}, new Set()`
      : `${JSON.stringify(template)}, {}, '/tmp/reviewos-component-example.stx', '/tmp', {}, new Set()`
    const code = `import { ${entry} } from '@stacksjs/stx/${module}'; console.log(JSON.stringify(await ${entry}(${args})))`
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', code], { stdout: 'pipe', stderr: 'pipe' })
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 3000)
    try {
      const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(timedOut).toBe(false)
      expect(exit, err).toBe(0)
      expect(JSON.parse(out)).toBe(template)
    }
    finally { clearTimeout(deadline); child.kill('SIGKILL') }
  })
}
