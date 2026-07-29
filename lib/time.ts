/**
 * The API speaks UTC; patients hear Mountain Time.
 *
 * This conversion is done in code, never by the model. Left to the model it is
 * wrong often and silently: the same 21:30Z slot has been read back as "3:30
 * PM", "9:30 AM", and "3:30 AM" across runs, and a patient who is told the
 * wrong hour has no way to catch it. Tools hand over a preformatted local
 * string and the model repeats it.
 */

import { PRACTICE } from './config';

export const PRACTICE_TIMEZONE = PRACTICE.timezone;

const longFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PRACTICE_TIMEZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

const isoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: PRACTICE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today at the practice, as YYYY-MM-DD.
 *
 * The API's date parameters are calendar days at the office, and the office is
 * in Denver. A UTC date is a different day there for six or seven hours of
 * every one — so an evening booking would search from tomorrow, and "next
 * Tuesday" would resolve a week out from the wrong day. Assembled from parts
 * rather than sliced off an ISO string for exactly that reason.
 */
export function practiceDate(now = new Date()): string {
  const parts = isoParts.formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * True for a zero-padded YYYY-MM-DD and nothing else.
 *
 * Worth checking rather than assuming, because these dates come from a model:
 * "2026-8-5" reads as a date to a person and sorts before "2026-09-27" to a
 * computer, so a comparison that trusts the shape quietly draws the wrong
 * conclusion about which window is wider.
 */
export const isCalendarDate = (value: string | undefined): value is string =>
  value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * A calendar day some days after another, as YYYY-MM-DD.
 *
 * Plain arithmetic on a date with no time and no zone: the practice's calendar
 * does not shift because a clock did, and a window that lands a day out because
 * of a daylight-saving boundary is a window that misses a real opening.
 *
 * Undefined for anything that is not already a calendar date, rather than
 * throwing on it — this is called with model-supplied values, and a RangeError
 * out of `toISOString` is not a recoverable tool result, it is a dead turn.
 */
export function addDays(isoDate: string, days: number): string | undefined {
  if (!isCalendarDate(isoDate)) return undefined;

  const [year, month, day] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return Number.isNaN(shifted.getTime())
    ? undefined
    : shifted.toISOString().slice(0, 10);
}

/** "Wednesday, August 5, 2026 at 3:30 PM MDT" */
export function toPracticeTime(utcIso: string): string {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return utcIso;

  return longFormat.format(date).replace(' at ', ' at ');
}

/** morning / afternoon, so the agent can honour "mornings are best" honestly. */
export function partOfDay(utcIso: string): 'morning' | 'afternoon' {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PRACTICE_TIMEZONE,
      hour: 'numeric',
      hour12: false,
    }).format(new Date(utcIso)),
  );

  return hour < 12 ? 'morning' : 'afternoon';
}
