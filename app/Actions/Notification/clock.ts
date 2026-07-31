/**
 * Turning an instant into somebody's local weekday and minute.
 *
 * `delivery.ts` deliberately knows nothing about timezones: every rule there
 * takes a weekday and a minute, so it can be tested without pretending it is
 * Tuesday in Berlin. This is the one place that bridges the two, and it is
 * separate so the awkward part is small and has its own tests.
 *
 * Deterministic despite reading a calendar: the same instant and the same zone
 * always produce the same answer, including across a daylight saving change,
 * which is exactly the case a hand-rolled offset gets wrong.
 */

import type { LocalTime } from './delivery'

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/**
 * The local weekday and minute in a timezone, for an instant.
 *
 * An unknown or malformed zone falls back to UTC rather than throwing. A
 * notification is not worth losing over a bad string in a settings row, and the
 * fallback is visible in the interface as a schedule that is an hour out rather
 * than as silence.
 */
export function localTimeIn(timezone: string, epochMs: number): LocalTime {
  const parts = format(timezone, epochMs) ?? format('UTC', epochMs)

  if (!parts)
    return { epochMs, weekday: 0, minutes: 0 }

  return {
    epochMs,
    weekday: parts.weekday,
    minutes: parts.hour * 60 + parts.minute,
  }
}

function format(timezone: string, epochMs: number): { weekday: number, hour: number, minute: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })

    const parts = formatter.formatToParts(new Date(epochMs))
    const weekday = parts.find(part => part.type === 'weekday')?.value ?? ''
    const hourText = parts.find(part => part.type === 'hour')?.value ?? ''
    const minuteText = parts.find(part => part.type === 'minute')?.value ?? ''

    if (!(weekday in WEEKDAYS))
      return null

    // `hour12: false` renders midnight as 24 in some environments, which would
    // otherwise put a notification a day out at exactly the wrong moment.
    const hour = Number(hourText) % 24
    const minute = Number(minuteText)

    if (!Number.isInteger(hour) || !Number.isInteger(minute))
      return null

    return { weekday: WEEKDAYS[weekday]!, hour, minute }
  }
  catch {
    return null
  }
}

/** Parse the stored `days` column: "1,2,3,4,5" into the numbers it names. */
export function parseDays(days: string | null | undefined): number[] {
  if (!days)
    return []

  return [...new Set(
    days
      .split(',')
      .map(part => Number(part.trim()))
      .filter(day => Number.isInteger(day) && day >= 0 && day <= 6),
  )].sort((a, b) => a - b)
}

/** The inverse, for writing the column back. */
export function formatDays(days: readonly number[]): string {
  return [...new Set(days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b)
    .join(',')
}

/** Parse the stored `breaks_through` column into the event types it names. */
export function parseEventList(events: string | null | undefined): string[] {
  if (!events)
    return []

  return [...new Set(events.split(',').map(part => part.trim()).filter(Boolean))]
}
