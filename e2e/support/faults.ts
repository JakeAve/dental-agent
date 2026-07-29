import type { Fault } from './proxy';

/**
 * The API's own error envelopes, for the failures the sandbox will not produce
 * on cue.
 *
 * Shaped exactly as documented in test-scenarios.md so the agent meets them on
 * the code path it already has: `lib/tools/errors.ts` switches on `error.code`,
 * and an envelope that is merely close enough would fall to its default branch
 * and test nothing that ships.
 */

const envelope = (code: string, message: string) => ({
  error: { code, message, details: {} },
});

const APPOINTMENTS = '/api/v1/appointments';

/**
 * Pins a fault to the first hold the agent took, for as long as it keeps using
 * it.
 *
 * This is what makes the simulation honest. A hold that has expired or been
 * superseded is dead permanently: every confirm against it fails, and the only
 * way forward is a fresh hold. A fault that fired once and then stood aside
 * would let a retry of the dead hold succeed — impossible in reality, and it
 * would mark the exact mistake these tests exist to catch as a pass.
 */
const firstHold = (requestBody: string, seen: { holdIds: string[] }) =>
  seen.holdIds.length > 0 && requestBody.includes(seen.holdIds[0]);

/**
 * 410 on confirm — the five-minute hold lapsed (S27).
 *
 * The real thing needs a five-minute stall between hold and confirm. Injected,
 * the same recovery runs in seconds, and the lapsed hold stays lapsed.
 */
export const holdExpired = (): Fault => ({
  method: 'POST',
  route: APPOINTMENTS,
  status: 410,
  body: envelope('HOLD_EXPIRED', 'That hold has expired.'),
  when: firstHold,
});

/**
 * 409 on confirm — the hold was consumed or superseded (S28).
 *
 * Unreachable without injection in this agent: `confirmAppointment` always
 * sends `session.hold.holdId`, which a replacement hold overwrites, so it never
 * confirms a superseded hold on its own. That makes this the defensive path —
 * and the one worth proving, because its guidance is "do NOT blindly re-book".
 */
export const holdAlreadyUsed = (): Fault => ({
  method: 'POST',
  route: APPOINTMENTS,
  status: 409,
  body: envelope(
    'HOLD_ALREADY_USED',
    'That hold was already used or has been superseded.',
  ),
  when: firstHold,
});
