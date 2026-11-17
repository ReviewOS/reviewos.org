interface WorkflowIdentity { name: unknown, path: unknown, state: unknown }

/** Full paths are exact; short aliases must identify one current workflow. */
export function selectWorkflow<T extends WorkflowIdentity>(candidates: T[], wanted: string): { workflow?: T, error?: string } {
  const exact = candidates.find(row => String(row.path) === wanted)
  if (exact) return { workflow: exact }
  const files = candidates.filter(row => String(row.path).endsWith(`/${wanted}`))
  const matches = files.length ? files : candidates.filter(row => String(row.name) === wanted)
  // A provider migration can retain the removed .github/ci.yml beside the
  // active .reviewos/ci.yml. Historical row order must not select the old one.
  const active = matches.filter(row => String(row.state) === 'active')
  const current = matches.filter(row => String(row.state) !== 'removed')
  const chosen = active.length ? active : current.length ? current : matches
  if (chosen.length > 1) return { error: 'More than one workflow matches this name. Use a full workflow path.' }
  return { workflow: chosen[0] }
}
