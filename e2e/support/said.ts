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

/* ------------------------------------------------------------------ *
 * Claiming something happened
 * ------------------------------------------------------------------ */

/**
 * Sentences that assert a booking exists, as opposed to offering to make one.
 *
 * Tense is the whole distinction: "I've booked you in" is a claim, "I'll book
 * that for you" is not. Kept to completed forms for that reason.
 */
const BOOKED_CLAIM =
  /\b(?:you(?:'re| are) (?:all set|booked|scheduled)|(?:is|are|has been|have been) (?:confirmed|booked|scheduled)|i(?:'ve| have) (?:booked|scheduled|confirmed))\b/i;

/**
 * Anything that flips the claim into a denial — "that has NOT been booked".
 *
 * `nothing` and `none` are listed in their own right: `\bno\b` does not match
 * inside "nothing", so "Nothing has been booked yet" read as a claim until a
 * test caught it.
 */
const NEGATOR =
  /\b(?:not|n't|no|nothing|none|never|unable|cannot|fail(?:ed)?|couldn)\b/i;

/**
 * Did the agent tell the patient a booking exists?
 *
 * Checked sentence by sentence, because a reply that says "nothing has been
 * booked yet — shall I look again?" contains a claim pattern and a denial, and
 * only their pairing within one sentence tells you which was meant.
 *
 * Used for the assertion that matters most on a failed booking: when the API
 * created nothing, no reply may say otherwise.
 */
export function claimsBooked(message: string): boolean {
  return message
    .split(/(?<=[.!?\n])/)
    .some((sentence) => BOOKED_CLAIM.test(sentence) && !NEGATOR.test(sentence));
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

