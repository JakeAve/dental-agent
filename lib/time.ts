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
