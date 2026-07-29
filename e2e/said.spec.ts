import { describe, expect, it } from 'vitest';
import type { Appointment } from '../lib/cedar-ridge';
import {
  claimsBooked,
  confirmationMessage,
  statesAmount,
  statesProvider,
  statesTime,
} from './support/said';

/**
 * Unit tests for the matchers behind the definition-of-done spec.
 *
 * These exist because the previous suite was green while the agent booked the
 * wrong day: an assertion nobody has watched fail is not evidence. The negative
 * cases below are the real content — a matcher that returns true for everything
 * would make done.spec.ts pass forever.
 *
 * The fixture is a real transcript. On 2026-07-29 the agent was asked for
 * "Thursday, July 30 at 8:00 AM with Tom Becker" and booked Wednesday, July 29
 * at 4:00 PM, then reported the Wednesday slot back. Both appointments below
 * are genuine records from that sandbox.
 */

const WEDNESDAY: Appointment = {
  id: '1a44266b-99dc-4533-8c26-dc15d9b18fa6',
  patient_id: '2d262527-b199-4da9-80e3-35ab56121522',
  service_code: 'D1110',
  service_name: 'Adult Cleaning',
  provider: { id: 'p1', name: 'Tom Becker RDH', type: 'hygienist' },
  starts_at: '2026-07-29T22:00:00Z', // 4:00 PM MDT
  duration_minutes: 45,
  status: 'confirmed',
  self_pay_price: 12500,
};

const THURSDAY: Appointment = {
  ...WEDNESDAY,
  id: '91ea7214-a0cc-4a83-abdd-36fd86a680ca',
  starts_at: '2026-07-30T14:00:00Z', // 8:00 AM MDT
};

const REPORTED_WEDNESDAY =
  'Your appointment for a routine cleaning with Tom Becker RDH is confirmed ' +
  'for **Wednesday, July 29, 2026 at 4:00 PM**. You will owe $125.00 as a ' +
  'self-pay patient.';

describe('statesTime', () => {
  it('accepts the time it actually reported', () => {
    expect(statesTime(REPORTED_WEDNESDAY, WEDNESDAY.starts_at)).toBe(true);
  });

  it('rejects a different day at the same clock time', () => {
    const sameClock = 'Confirmed for Thursday, July 30, 2026 at 4:00 PM.';
    expect(statesTime(sameClock, WEDNESDAY.starts_at)).toBe(false);
  });

  it('rejects the same day at a different clock time', () => {
    expect(statesTime(REPORTED_WEDNESDAY, THURSDAY.starts_at)).toBe(false);
  });

  it('rejects a bare time with no date', () => {
    expect(statesTime('You are all set for 4:00 PM.', WEDNESDAY.starts_at)).toBe(
      false,
    );
  });

  it('rejects a UTC timestamp read out raw', () => {
    expect(statesTime('Booked for 2026-07-29T22:00:00Z.', WEDNESDAY.starts_at)).toBe(
      false,
    );
  });
});

describe('statesProvider', () => {
  it('accepts the surname', () => {
    expect(statesProvider(REPORTED_WEDNESDAY, 'Tom Becker RDH')).toBe(true);
  });

  it('rejects a different provider', () => {
    expect(statesProvider(REPORTED_WEDNESDAY, 'Maria Gonzalez RDH')).toBe(false);
  });
});

describe('statesAmount', () => {
  it('accepts the exact figure', () => {
    expect(statesAmount(REPORTED_WEDNESDAY, WEDNESDAY)).toBe(true);
  });

  it('rejects a message quoting the wrong figure', () => {
    expect(statesAmount('You will owe $25.00.', WEDNESDAY)).toBe(false);
  });

  it('rejects a message that never mentions money', () => {
    expect(
      statesAmount('You are booked for Wednesday, July 29 at 4:00 PM.', WEDNESDAY),
    ).toBe(false);
  });
});

describe('claimsBooked', () => {
  it('catches a completed booking claim', () => {
    expect(claimsBooked(REPORTED_WEDNESDAY)).toBe(true);
    expect(claimsBooked("You're all set for Thursday at 8 AM.")).toBe(true);
    expect(claimsBooked("I've booked you in with Dr. Reyes.")).toBe(true);
  });

  it('does not mistake an offer to book for a booking', () => {
    // The distinction the recovery specs depend on: after a failed confirm the
    // agent may say what it *will* do, but not that it already did.
    expect(claimsBooked('I can book that for you — shall I go ahead?')).toBe(false);
    expect(claimsBooked('Once you confirm, I will book it right away.')).toBe(false);
    expect(claimsBooked('Would you like me to book Thursday at 8?')).toBe(false);
  });

  it('does not mistake a denial for a claim', () => {
    expect(claimsBooked('Nothing has been booked yet.')).toBe(false);
    expect(claimsBooked("I wasn't able to book that time, sorry.")).toBe(false);
    expect(claimsBooked('That time is no longer available, so it is not booked.')).toBe(
      false,
    );
  });

  it('catches a claim that shares a reply with an unrelated denial', () => {
    // One sentence denies, the next claims. Judged per sentence, so the claim
    // still counts — a whole-message negation check would miss this.
    expect(
      claimsBooked(
        'I could not reach your insurer. Your cleaning is confirmed for Thursday at 8:00 AM.',
      ),
    ).toBe(true);
  });
});

describe('confirmationMessage', () => {
  const transcript = [
    { role: 'patient' as const, content: 'I would like a cleaning.' },
    { role: 'agent' as const, content: REPORTED_WEDNESDAY },
  ];

  it('finds the reply that states time, provider and amount together', () => {
    expect(confirmationMessage(transcript, WEDNESDAY)).toBeDefined();
  });

  it('finds nothing when the record is a slot the agent never reported', () => {
    // The exact S02 defect: booked one slot, told the patient another.
    expect(confirmationMessage(transcript, THURSDAY)).toBeUndefined();
  });

  it('finds nothing when the facts are split across replies', () => {
    const split = [
      { role: 'agent' as const, content: 'Booked for Wednesday, July 29 at 4:00 PM.' },
      { role: 'agent' as const, content: 'With Tom Becker. You will owe $125.00.' },
    ];
    expect(confirmationMessage(split, WEDNESDAY)).toBeUndefined();
  });
});
