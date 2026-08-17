/**
 * The published conformance page.
 *
 * The data lives in [the domain](../Actions/Workflow/conformance.ts), because
 * it is what the parser warns from as well as what this renders - one table for
 * the page, the test and the warnings, so a difference cannot be documented one
 * way and behave another.
 */

import type { ConformanceStatus } from '../Actions/Workflow/conformance'
import { CONFORMANCE, conformanceCounts } from '../Actions/Workflow/conformance'

const TITLES: Record<ConformanceStatus, string> = {
  supported: 'Supported',
  differs: 'Different on purpose',
  unimplemented: 'Not implemented yet',
  refused: 'Refused',
}

const NOTES: Record<ConformanceStatus, string> = {
  supported: 'These do what Actions does. A workflow using only these keys behaves the same here.',
  differs: 'These work, and deliberately not the way Actions does. Every one is a decision you should be able to disagree with, so the reason is next to it.',
  unimplemented: 'These are read and do nothing yet. A workflow using one is told - on its run, or on the workflow page - rather than left to wonder why nothing happened.',
  refused: 'These will not be implemented in this form.',
}

/**
 * The published page.
 *
 * Generated rather than written, so a key whose behaviour changes without its
 * line changing fails the drift test rather than misleading somebody quietly
 * for a year.
 */
export function renderConformance(at: string): string {
  const counts = conformanceCounts()

  const lines = [
    '# Workflow conformance',
    '',
    'What this instance does with every key a workflow can contain.',
    '',
    'The point of publishing it: **silence about a gap is how a forge surprises people.** A key that',
    'is accepted and does nothing has not been implemented - the fact that it has not has been',
    'hidden. So every key here has a status and a sentence, including the ones that are missing and',
    'the ones that are deliberately different.',
    '',
    `${counts.supported} keys behave as Actions does, ${counts.differs} differ on purpose, `
    + `${counts.unimplemented} ${counts.unimplemented === 1 ? 'is' : 'are'} not implemented yet, `
    + `and ${counts.refused} ${counts.refused === 1 ? 'is' : 'are'} refused.`,
    '',
    `Generated ${at}.`,
    '',
  ]

  for (const status of ['supported', 'differs', 'unimplemented', 'refused'] as ConformanceStatus[]) {
    const entries = CONFORMANCE.filter(entry => entry.status === status)

    if (entries.length === 0)
      continue

    lines.push(`## ${TITLES[status]}`, '', NOTES[status], '', '| Key | Where | What this instance does |', '| --- | --- | --- |')

    for (const entry of entries)
      lines.push(`| \`${entry.key}\` | ${entry.level} | ${entry.behaviour} |`)

    lines.push('')
  }

  return lines.join('\n')
}
