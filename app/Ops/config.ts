/**
 * Checking the configuration before the instance starts serving.
 *
 * The failure this prevents is the one that costs an evening: a value that is
 * wrong in a way nothing notices until the code path that reads it runs. A
 * missing `APP_KEY` surfaces as a session that will not persist. A `DB_PORT` of
 * `"5432 "` surfaces as a connection refused at the first request. A mail
 * password that was never set surfaces the first time somebody resets a
 * password, which is a fortnight later and to a stranger.
 *
 * So every value that has to be right is checked at boot, and a bad one stops
 * the process with a sentence naming the variable and what to do. An instance
 * that will not start is a five-minute problem; an instance that starts and is
 * subtly wrong is a support thread.
 *
 * **Pure over a plain object.** It takes the environment rather than reading
 * `process.env`, so every rule here is testable without setting a variable in
 * the test runner's own process - which is a thing that leaks between tests and
 * cannot be undone reliably.
 */

export type Severity = 'fatal' | 'warning'

export interface Finding {
  variable: string
  severity: Severity
  problem: string
  /** What to do about it. Absent only when there is genuinely nothing to say. */
  fix: string
}

export interface Verdict {
  ok: boolean
  findings: Finding[]
}

/**
 * A production instance is held to more than a development one.
 *
 * Not because the rules differ in principle, but because a developer running
 * `buddy dev` with a default key has made a reasonable choice and a production
 * instance with the same key has made a serious mistake. Refusing to start in
 * development over a mail password nobody set would teach people to bypass this
 * check, and a check people bypass is worse than no check.
 */
export function inspect(env: Record<string, string | undefined>, options: { production?: boolean } = {}): Verdict {
  const production = options.production ?? String(env.APP_ENV ?? '').toLowerCase() === 'production'
  const findings: Finding[] = []

  const value = (name: string) => String(env[name] ?? '').trim()

  /*
   * The application key. Everything encrypted or signed depends on it, and a
   * default or absent one means sessions that do not survive a restart and
   * signatures anybody can forge.
   */
  const key = value('APP_KEY')
  if (!key) {
    findings.push({
      variable: 'APP_KEY',
      severity: production ? 'fatal' : 'warning',
      problem: 'is not set, so anything encrypted or signed cannot be',
      fix: 'Run `buddy key:generate`.',
    })
  }
  else if (key.length < 32) {
    findings.push({
      variable: 'APP_KEY',
      severity: 'fatal',
      problem: `is ${key.length} characters, which is too short to be a real key`,
      fix: 'Run `buddy key:generate`. A truncated key is worse than none: it looks configured.',
    })
  }

  /*
   * The URL this instance believes it is at.
   *
   * Wrong here means every link in every email points somewhere else, every
   * redirect after signing in lands on the wrong host, and a webhook receiver
   * cannot resolve what it was sent. None of it fails; it all just goes to the
   * wrong place.
   */
  const url = value('APP_URL')
  if (!url) {
    findings.push({
      variable: 'APP_URL',
      severity: production ? 'fatal' : 'warning',
      problem: 'is not set, so links in email and redirects have nowhere to point',
      fix: 'Set it to the address people type, including the scheme.',
    })
  }
  else {
    /*
     * A scheme is optional, and that is the framework's convention rather than
     * an oversight: `config.app.url` is used as a *domain* in most places
     * (`helpers.ts` defaults it to a bare `stacks`), and this project's own
     * default is `reviewos.localhost`. Requiring one here would have flagged
     * every correctly configured instance, which is how a boot check gets
     * disabled.
     *
     * What is worth flagging is a value carrying a path, because that is
     * somebody pasting a browser URL in and every generated link then has the
     * path twice.
     */
    const withoutScheme = url.replace(/^https?:\/\//, '')
    if (withoutScheme.includes('/') && !withoutScheme.endsWith('/')) {
      findings.push({
        variable: 'APP_URL',
        severity: 'warning',
        problem: `is "${url}", which carries a path`,
        fix: 'Use the host on its own. A path here appears twice in every generated link.',
      })
    }

    if (production && url.startsWith('http://') && !isLocal(url)) {
      findings.push({
        variable: 'APP_URL',
        severity: 'warning',
        problem: 'is http, so every token and session cookie crosses the network in the clear',
        fix: 'Terminate TLS in front of this and set https, or the credentials this issues are readable in transit.',
      })
    }

    if (url.endsWith('/')) {
      findings.push({
        variable: 'APP_URL',
        severity: 'warning',
        problem: 'ends with a slash, which produces double slashes in generated links',
        fix: 'Drop the trailing slash.',
      })
    }
  }

  // The database. Nothing works without it, and the failure without this check
  // is a connection error at the first request rather than at boot.
  for (const name of ['DB_CONNECTION', 'DB_DATABASE', 'DB_USERNAME']) {
    if (!value(name)) {
      findings.push({
        variable: name,
        severity: 'fatal',
        problem: 'is not set, so this instance cannot reach its database',
        fix: 'Set it in .env. `buddy setup` writes a working local set.',
      })
    }
  }

  const port = value('DB_PORT')
  if (port && !/^\d+$/.test(port)) {
    findings.push({
      variable: 'DB_PORT',
      severity: 'fatal',
      problem: `is "${port}", which is not a port number`,
      fix: 'A stray space or quote is the usual cause, and it reads as a connection refused.',
    })
  }

  /*
   * Mail. A warning rather than fatal, because an instance with no mail is a
   * perfectly reasonable private deployment - but somebody should know, since
   * password resets and review notifications both go out this way and their
   * absence is silent.
   */
  if (production && !value('MAIL_HOST') && !value('MAIL_DRIVER')) {
    findings.push({
      variable: 'MAIL_HOST',
      severity: 'warning',
      problem: 'is not set, so no password reset or notification email can be sent',
      fix: 'Set a mail driver, or accept that this instance is invite-only and nobody can reset a password.',
    })
  }

  return {
    // Warnings are printed and do not stop anything. A check that refuses to
    // start over something survivable is a check people learn to disable.
    ok: !findings.some(finding => finding.severity === 'fatal'),
    findings,
  }
}

/**
 * The findings, as something to print.
 *
 * One line per finding, variable first, because the variable is what somebody
 * greps their `.env` for. The fix is on its own line rather than in
 * parentheses: it is the part they act on.
 */
export function describe(verdict: Verdict): string {
  if (verdict.findings.length === 0)
    return 'Configuration looks fine.'

  return verdict.findings
    .map(finding => `${finding.severity === 'fatal' ? 'FATAL' : 'warning'}  ${finding.variable} ${finding.problem}\n         ${finding.fix}`)
    .join('\n')
}

/** Whether a URL points at this machine, where plain http is not a mistake. */
function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname

    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  }
  catch {
    return false
  }
}
