import { afterEach, describe, expect, it } from 'vitest';
import type { Appointment } from '../lib/cedar-ridge';
import { PRACTICE } from '../lib/config';
import { PERSONAS } from './support/personas';
import { cleanup, formatTranscript, runScenario, type RunResult } from './support/run';
import { fetchAppointments, SERVICE } from './support/verify';
import {
  confirmationMessage,
  money,
  partsOf,
  statesAmount,
  statesProvider,
  statesTime,
} from './support/said';

/**
 * The exercise's own definition of done, asserted literally:
 *
 *   1. The patient's appointment exists in the system with the correct
 *      service, provider, time, and price.
 *   2. The agent told the patient what was booked and what they'll owe.
 *
 * Clause 1 is checked against the API record, never the agent's prose. Clause 2
 * is checked against the prose, and — this is the point — the two must agree.
 * An agent that books Wednesday and says Thursday satisfies neither, but passes
 * any test that only looks at one of them. That exact failure happened: S02
 * booked Wednesday 4:00 PM after the patient chose Thursday 8:00 AM, and the
 * suite was green because nothing compared the record to the conversation.
 *
 * No LLM judge here on purpose. Everything below is a fact or a string match,
 * so a failure is a bug rather than a mood.
 */

let created: string[] = [];

afterEach(async () => {
  await cleanup(created);
  created = [];
});

/* ------------------------------------------------------------------ *
 * Clause 1 — the record
 * ------------------------------------------------------------------ */

function assertRecordIsCorrect(
  appt: Appointment,
  expected: { service: string; providerType: string; paying: 'copay' | 'self_pay' },
  run: RunResult,
) {
  const ctx = formatTranscript(run.transcript);

  expect(appt.status, `appointment is not confirmed.${ctx}`).toBe('confirmed');
  expect(appt.service_code, `wrong service booked.${ctx}`).toBe(expected.service);

  // A cleaning must land with a hygienist, an exam with a dentist. The agent
  // does not choose the provider, but booking the wrong service class shows up
  // here even when the service code happens to look right.
  expect(appt.provider.type, `wrong kind of provider.${ctx}`).toBe(
    expected.providerType,
  );
  expect(appt.provider.name, `appointment has no provider.${ctx}`).toBeTruthy();

  // Time must be real, future, in business hours, on a weekday.
  const when = new Date(appt.starts_at);
  expect(Number.isNaN(when.getTime()), `unparseable start time.${ctx}`).toBe(false);
  expect(when.getTime(), `appointment is in the past.${ctx}`).toBeGreaterThan(
    Date.now(),
  );

  const local = partsOf(appt.starts_at);
  expect(
    ['Saturday', 'Sunday'].includes(local.weekday),
    `booked on a ${local.weekday}; the practice runs ${PRACTICE.hours}.${ctx}`,
  ).toBe(false);

  const hour24 =
    (Number(local.hour) % 12) + (local.meridiem === 'PM' ? 12 : 0);
  expect(
    hour24 >= 8 && hour24 < 17,
    `booked at ${local.hour}:${local.minute} ${local.meridiem}, outside ${PRACTICE.hours}.${ctx}`,
  ).toBe(true);

  // Exactly one price, and it must match the route the patient actually took.
  if (expected.paying === 'copay') {
    expect(appt.copay, `insured patient owes no copay.${ctx}`).toBeDefined();
    expect(appt.self_pay_price, `insured patient charged self-pay.${ctx}`).toBeUndefined();
  } else {
    expect(appt.self_pay_price, `self-pay patient has no price.${ctx}`).toBeDefined();
    expect(appt.copay, `self-pay patient given a copay.${ctx}`).toBeUndefined();
  }
}

/* ------------------------------------------------------------------ *
 * Clause 2 — the telling
 * ------------------------------------------------------------------ */

function assertPatientWasTold(run: RunResult, appt: Appointment) {
  const ctx = formatTranscript(run.transcript);
  const agentSaid = run.transcript.filter((t) => t.role === 'agent');
  const last = agentSaid.at(-1)?.content ?? '';

  // Each part separately, so a failure names what was missing rather than
  // just "the confirmation was wrong".
  const anyStates = (fn: (m: string) => boolean) =>
    agentSaid.some((t) => fn(t.content));

  expect(
    anyStates((m) => statesTime(m, appt.starts_at)),
    `the agent never told the patient the booked date and time ` +
      `(${appt.starts_at} UTC).${ctx}`,
  ).toBe(true);

  expect(
    anyStates((m) => statesProvider(m, appt.provider.name)),
    `the agent never named the provider (${appt.provider.name}).${ctx}`,
  ).toBe(true);

  expect(
    anyStates((m) => statesAmount(m, appt)),
    `the agent never told the patient what they owe ` +
      `(${money(appt.copay ?? appt.self_pay_price ?? 0)}).${ctx}`,
  ).toBe(true);

  // All three in one message: the patient has to be able to read the booking
  // off a single reply, not assemble it from four.
  expect(
    confirmationMessage(run.transcript, appt),
    `no single reply stated the time, provider and amount together.${ctx}`,
  ).toBeDefined();

  // And the last thing said must not contradict the record — this is the
  // check that catches "booked Wednesday, said Thursday".
  const contradicts =
    statesTime(last, appt.starts_at) === false &&
    /\b(booked|confirmed|scheduled|all set)\b/i.test(last);

  expect(
    contradicts,
    `the agent's closing reply claims a booking but does not match the ` +
      `record (${appt.starts_at} UTC).${ctx}`,
  ).toBe(false);
}

/* ------------------------------------------------------------------ *
 * The scenarios
 * ------------------------------------------------------------------ */

describe("definition of done", () => {
  it(
    'S02 — self-pay cleaning: booked correctly and reported accurately',
    { timeout: 180_000 },
    async () => {
      const run = await runScenario(PERSONAS.S02);
      created = run.appointmentIds;

      expect(run.rateLimited, 'run key hit its budget (429)').toBe(false);
      expect(
        run.appointmentIds,
        `nothing was booked.${formatTranscript(run.transcript)}`,
      ).toHaveLength(1);

      const [appt] = await fetchAppointments(run.appointmentIds);

      assertRecordIsCorrect(
        appt,
        { service: SERVICE.cleaning, providerType: 'hygienist', paying: 'self_pay' },
        run,
      );
      assertPatientWasTold(run, appt);
    },
  );

  it(
    'S01 — insured new patient: booked correctly and reported accurately',
    { timeout: 240_000 },
    async () => {
      const run = await runScenario(PERSONAS.S01);
      created = run.appointmentIds;

      expect(run.rateLimited, 'run key hit its budget (429)').toBe(false);
      expect(
        run.appointmentIds,
        `nothing was booked.${formatTranscript(run.transcript)}`,
      ).toHaveLength(1);

      const [appt] = await fetchAppointments(run.appointmentIds);

      assertRecordIsCorrect(
        appt,
        { service: SERVICE.cleaning, providerType: 'hygienist', paying: 'copay' },
        run,
      );
      assertPatientWasTold(run, appt);
    },
  );
});
