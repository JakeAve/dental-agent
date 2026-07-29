import type { Appointment } from '../../lib/cedar-ridge';
import { PRACTICE } from '../../lib/config';
import type { Exchange } from './patient';

/**
 * Does a reply actually say what was booked?
 *
 * Pure string work, kept out of the spec so it can be falsified on its own —
 * a matcher that returns true for everything makes a suite that always passes,
 * which is the failure this whole file is guarding against.
 */

/* ------------------------------------------------------------------ *
 * Reading the practice's clock
 * ------------------------------------------------------------------ */

export const partsOf = (iso: string) => {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: PRACTICE.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const got = Object.fromEntries(
    fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );

  return {
    weekday: got.weekday,
    month: got.month,
    day: got.day,
    hour: got.hour,
    minute: got.minute,
    meridiem: (got.dayPeriod ?? '').toUpperCase().replace(/\./g, ''),
  };
};

/** Lowercased, punctuation-light, whitespace-collapsed — for tolerant matching. */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Did this message state the appointment's time?
 *
 * Requires the clock time *and* the calendar date. "4:00 PM" alone is not
 * telling someone when their appointment is, and a wrong day is the failure
 * mode this whole file exists for.
 */
export function statesTime(message: string, iso: string): boolean {
  const t = partsOf(iso);
  const text = normalize(message);

  const clock = `${t.hour}:${t.minute}`;
  const saidClock = text.includes(clock) && text.includes(t.meridiem.toLowerCase());

  const saidDate =
    text.includes(`${t.month.toLowerCase()} ${t.day}`) ||
    text.includes(t.weekday.toLowerCase());

  return saidClock && saidDate;
}

/** Providers are given as "Maria Gonzalez RDH"; the surname is enough. */
export function statesProvider(message: string, provider: string): boolean {
  const surname = provider.split(/\s+/)[1] ?? provider;
  return normalize(message).includes(surname.toLowerCase());
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The amount owed, as the patient would read it. */
export function statesAmount(message: string, appt: Appointment): boolean {
  const cents = appt.copay ?? appt.self_pay_price;
  if (cents === undefined) return false;

  const text = normalize(message);
  const exact = money(cents).toLowerCase();
  const whole = `$${Math.round(cents / 100)}`;

  return text.includes(exact) || text.includes(whole);
}

/** The one message where the agent reported the booking, if there is one. */
export function confirmationMessage(
  transcript: Exchange[],
  appt: Appointment,
): Exchange | undefined {
  return transcript
    .filter((t) => t.role === 'agent')
    .find(
      (t) =>
        statesTime(t.content, appt.starts_at) &&
        statesProvider(t.content, appt.provider.name) &&
        statesAmount(t.content, appt),
    );
}

