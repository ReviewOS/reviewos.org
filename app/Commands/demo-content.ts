/**
 * The contents of the demonstration repository.
 *
 * Separate from the seeding logic so the command reads as a sequence of commits
 * rather than as a wall of file contents, and so the two can be changed without
 * touching each other.
 *
 * The change these files describe is a real one: rounding a cart's tax once at
 * the end rather than per line, which makes the total disagree with the receipt
 * printed beside it. It is the kind of change worth reviewing, which matters
 * because this is what the review screen is demonstrated with.
 */

export const README = `# checkout

The pricing and cart logic, extracted so it can be tested without a checkout
flow around it.
`

export const MONEY = `/** Money is integer cents everywhere. Floats do not survive a tax rate. */
export function cents(amount: number): number {
  return Math.round(amount * 100)
}

export function format(value: number): string {
  return \`$\${(value / 100).toFixed(2)}\`
}
`

export const CART_BEFORE = `import { cents } from './money'

export interface Line {
  name: string
  unitPrice: number
  quantity: number
  taxRate: number
}

/**
 * The total for a cart.
 *
 * Tax is applied to the sum and rounded once at the end.
 */
export function total(lines: Line[]): number {
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)
  const tax = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity * line.taxRate, 0)

  return cents((subtotal + tax) / 100)
}
`

export const CART_AFTER = `import { cents } from './money'

export interface Line {
  name: string
  unitPrice: number
  quantity: number
  taxRate: number
}

/**
 * The total for a cart.
 *
 * Tax is applied and rounded per line, not once at the end. Rounding the sum
 * makes the total disagree with the receipt beside it, because the receipt
 * shows each line rounded and a reader adds those up.
 */
export function total(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0)
}

/** One line, tax included, rounded to the cent. */
export function lineTotal(line: Line): number {
  const net = line.unitPrice * line.quantity

  return cents((net + net * line.taxRate) / 100)
}
`

export const CART_TEST = `import { describe, expect, test } from 'bun:test'
import { lineTotal, total } from '../src/cart'

describe('total', () => {
  test('rounds each line rather than the sum', () => {
    // Three lines that each land on a half cent. Rounded once at the end this
    // came to 302; rounded per line it is 303, which is what the receipt says.
    const lines = Array.from({ length: 3 }, () => ({
      name: 'Widget',
      unitPrice: 95,
      quantity: 1,
      taxRate: 0.055,
    }))

    expect(total(lines)).toBe(303)
  })

  test('a single line is its own total', () => {
    const line = { name: 'Widget', unitPrice: 100, quantity: 2, taxRate: 0.1 }

    expect(total([line])).toBe(lineTotal(line))
  })

  test('an empty cart is free', () => {
    expect(total([])).toBe(0)
  })
})
`

export const PRICING_DOCS = `# Pricing

Money is integer cents throughout. A float survives one multiplication and not
two, and a tax rate is the second one.
`

export const PRICING_DOCS_AFTER = `# Pricing

Money is integer cents throughout. A float survives one multiplication and not
two, and a tax rate is the second one.

## Rounding

Each line is rounded to the cent with tax included, and the total is the sum of
the rounded lines. A half rounds up.

The alternative, rounding once at the end, makes the total disagree with the
receipt printed beside it: the receipt shows rounded lines, and anybody adding
them up gets a different answer from the one they were charged.
`

export const PULL_REQUEST_BODY = `Rounding once at the end made the total disagree with the receipt beside it. The
receipt shows each line rounded, so a customer adding the lines up got a
different number from the one they were charged, by a cent or two on a large
order.

Each line is now rounded with its tax included and the total is the sum of those.

- \`lineTotal\` is exported so the receipt renderer can use exactly the same
  rounding rather than repeating it
- The test covers three lines that each land on a half cent, which is the case
  that produced the original report
`
