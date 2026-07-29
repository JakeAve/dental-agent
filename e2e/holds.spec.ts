import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '../lib/cedar-ridge';
import { holdAlreadyUsed, holdExpired } from './support/faults';
import { PERSONAS } from './support/personas';
import { sendTurn } from './support/protocol';
import { startProxy } from './support/proxy';
import { claimsBooked, confirmationMessage } from './support/said';
import {
  AGENT_URL,
  apiConfig,
  cleanup,
  formatTranscript,
  runScenario,
  type RunResult,
} from './support/run';
import { fetchAppointments } from './support/verify';

/**
 * The hold lifecycle — S27, S28, S29.
 *
 * A hold is the only part of the booking chain with a clock on it, and every
 * way it can go wrong looks like success to an agent that does not read the
 * response: the slot is gone, the hold is spent, or the booking already
 * happened. All three end the same way if mishandled — a patient told they have
 * an appointment that does not exist, or given two.
 *
 * The failures are injected at the proxy (see `support/faults.ts`) because the
 * sandbox will not produce them on demand: a real expiry costs five minutes of
 * wall clock, and a real supersession needs a race. Every test here asserts
 * `faultsFired` first — an injection that silently never matched would leave the
 * rest of the test passing against an ordinary happy path.
 */

let created: string[] = [];

afterEach(async () => {
  await cleanup(created);
  created = [];
});

/**
 * Codes and statuses must never reach the patient (invariant 11).
 *
 * Bare three-digit numbers are deliberately not matched: the practice's own
 * phone number is 303-555-0142, and the front desk is the correct thing to
 * offer when a booking genuinely failed. Only the code names and an explicitly
 * labelled status count as a leak.
 */
const LEAKED =
  /\b(?:HOLD_EXPIRED|HOLD_ALREADY_USED|SLOT_TAKEN|SLOT_UNAVAILABLE|INSURANCE_REQUIRED|VALIDATION_FAILED)\b|\b(?:HTTP|status|error|code)\s*:?\s*\d{3}\b/i;

function assertNoLeak(run: RunResult) {
  for (const turn of run.transcript.filter((t) => t.role === 'agent')) {
    expect(
      turn.content,
      `a raw error code or status reached the patient: "${turn.content}"`,
    ).not.toMatch(LEAKED);
  }
}

/**
 * The invariant that outranks everything else here: what the agent said and
 * what the API holds must agree. Zero appointments and a claim of success is
 * the worst outcome in the suite — worse than an honest failure.
 */
function assertNoPhantomBooking(run: RunResult) {
  if (run.appointmentIds.length > 0) return;

  const phantom = run.transcript
    .filter((t) => t.role === 'agent')
    .find((t) => claimsBooked(t.content));

  expect(
    phantom,
    `nothing was booked, but the agent said it was: "${phantom?.content}"` +
      formatTranscript(run.transcript),
  ).toBeUndefined();
}

describe('hold lifecycle', () => {
  it(
    'S27 — recovers from an expired hold by taking a fresh one',
    { timeout: 240_000 },
    async () => {
      // Every confirm against the first hold meets a 410, exactly as a real
      // expiry would. A confirm on a fresh hold is forwarded, so a correct
      // recovery completes and an incorrect one cannot.
      const run = await runScenario(PERSONAS.S02, { faults: [holdExpired()] });
      created = run.appointmentIds;

      expect(
        run.faultsFired,
        'the 410 was never injected — this test proved nothing',
      ).toBeGreaterThanOrEqual(1);
      expect(run.rateLimited, 'the run key hit its budget (429)').toBe(false);

      const holds = run.calls.filter(
        (c) => c.method === 'POST' && c.route === '/api/v1/holds',
      );
      const confirms = run.calls.filter(
        (c) => c.method === 'POST' && c.route === '/api/v1/appointments',
      );

      // The recovery: a lapsed hold is re-taken, not retried. Confirming the
      // same dead hold again can never succeed.
      expect(
        holds.length,
        `expected a second hold after the expiry; the agent made ` +
          `${holds.length} hold(s) and ${confirms.length} confirm(s).` +
          formatTranscript(run.transcript),
      ).toBeGreaterThanOrEqual(2);

      // Not a retry storm: one injected failure plus a real confirm, with a
      // little slack. The guidance says re-hold, not hammer.
      expect(
        confirms.length,
        'the agent retried the booking too many times',
      ).toBeLessThanOrEqual(3);

      assertNoLeak(run);
      assertNoPhantomBooking(run);

      // Ground truth: the patient ends up with exactly one appointment.
      expect(
        run.appointmentIds,
        `expected one appointment after recovery.${formatTranscript(run.transcript)}`,
      ).toHaveLength(1);

      const [appt] = await fetchAppointments(run.appointmentIds);
      expect(appt.status).toBe('confirmed');

      // The specific way a recovery goes wrong quietly: the agent re-holds a
      // different slot than the one it first offered, books that, and reads the
      // original time back. The patient then arrives on the wrong day.
      expect(
        confirmationMessage(run.transcript, appt),
        `the agent never reported the appointment it actually booked ` +
          `(${appt.starts_at} UTC with ${appt.provider.name}).` +
          formatTranscript(run.transcript),
      ).toBeDefined();
    },
  );

  it(
    'S28 — a superseded hold never produces a second appointment',
    { timeout: 240_000 },
    async () => {
      // 409 HOLD_ALREADY_USED means "this may already have booked". The wrong
      // move is to re-book, which is how a patient ends up with two.
      const run = await runScenario(PERSONAS.S02, { faults: [holdAlreadyUsed()] });
      created = run.appointmentIds;

      expect(
        run.faultsFired,
        'the 409 was never injected — this test proved nothing',
      ).toBeGreaterThanOrEqual(1);
      expect(run.rateLimited, 'the run key hit its budget (429)').toBe(false);

      // The one unacceptable outcome. `maxBookings` caps the damage at 1, so a
      // refusal by the breaker is the same bug caught one layer lower.
      expect(
        run.appointmentIds.length,
        `the agent booked ${run.appointmentIds.length} appointments after a ` +
          `superseded hold.${formatTranscript(run.transcript)}`,
      ).toBeLessThanOrEqual(1);
      expect(
        run.refusedBookings,
        'the breaker refused a booking — the agent tried to book twice.' +
          formatTranscript(run.transcript),
      ).toBe(0);

      assertNoLeak(run);
      assertNoPhantomBooking(run);
    },
  );

  it(
    'S29 — replaying a consumed hold_id returns the same appointment',
    { timeout: 120_000 },
    async () => {
      // No agent and no model: this pins the API behaviour that the recovery
      // guidance in lib/tools/errors.ts is built on. If a replayed hold_id ever
      // starts creating a second appointment, HOLD_ALREADY_USED advice like
      // "the booking may have gone through" becomes actively dangerous, and
      // this test is the one that notices.
      const api = createClient(apiConfig());

      const patient = await api.registerPatient({
        status: 'returning',
        first_name: 'Idem',
        last_name: 'Replay',
        date_of_birth: '1979-06-11',
        phone: '555-461-2200',
        email: 'idem.replay@example.com',
      });

      await api.setInsurance(patient.id, { self_pay: true });

      const { availability } = await api.getAvailability({
        service: 'D1110',
        patient_id: patient.id,
      });

      expect(
        availability.length,
        'no slots available at all — cannot exercise the replay',
      ).toBeGreaterThan(0);

      const hold = await api.holdSlot({
        slot_id: availability[0].slot_id,
        patient_id: patient.id,
        service: 'D1110',
      });

      const first = await api.confirmAppointment({
        hold_id: hold.hold_id,
        notes: 'first submit',
      });
      created = [first.id];

      // The duplicate submit, byte-identical but for the note. Per the API
      // reference the first request's stored values win.
      const replay = await api.confirmAppointment({
        hold_id: hold.hold_id,
        notes: 'duplicate submit',
      });

      expect(
        replay.id,
        'the replay created a different appointment — hold_id is not idempotent',
      ).toBe(first.id);
      expect(replay.starts_at).toBe(first.starts_at);
      expect(replay.status).toBe('confirmed');

      created = [...new Set([first.id, replay.id])];
      expect(created, 'more than one distinct appointment exists').toHaveLength(1);
    },
  );

  it(
    'S29b — a retried booking turn books exactly once',
    { timeout: 180_000 },
    async () => {
      // The protocol's own idempotency requirement, on a turn with real
      // consequences: "A transport retry repeats the same IDs and must not
      // create a duplicate conversational action or booking." Conformance is
      // already covered on a harmless turn in protocol.spec.ts; this is the
      // version that can actually double-book a patient.
      const { baseUrl, apiKey } = apiConfig();
      const proxy = await startProxy({
        target: baseUrl,
        scenario: 'S29b',
        // Deliberately generous: capping at 1 would hide the very bug under
        // test behind the breaker. Two is enough to catch and still bounded.
        maxBookings: 2,
      });

      const runId = `e2e-retry-${randomUUID()}`;
      const turnId = randomUUID();
      const message =
        'Hi, I need to book a cleaning. I am a returning patient: Rita Reed, ' +
        'date of birth 1985-03-15, phone 555-222-3333, email ' +
        'rita.reed@example.com. I will self-pay. Please book the earliest ' +
        'available slot without checking back with me.';

      try {
        const first = await sendTurn({
          agentUrl: AGENT_URL,
          runId,
          turnId,
          message,
          dentalApi: { base_url: proxy.origin, api_key: apiKey },
        });

        // Same run_id and turn_id: a transport retry, not a new turn.
        const retry = await sendTurn({
          agentUrl: AGENT_URL,
          runId,
          turnId,
          message,
          dentalApi: { base_url: proxy.origin, api_key: apiKey },
        });

        expect(first.status).toBe(200);
        expect(retry.status).toBe(200);

        // The replay must be the stored answer, not a re-run of the agent.
        expect(retry.body.output?.message).toBe(first.body.output?.message);

        const ids = [...new Set(proxy.appointmentIds)];
        expect(
          ids.length,
          `a retried turn created ${ids.length} appointments — the retry ` +
            're-ran the agent instead of replaying its answer',
        ).toBeLessThanOrEqual(1);

        // Guards against a vacuous pass: if the booking never happened at all,
        // "only one appointment" is true for the wrong reason.
        expect(
          ids.length,
          `nothing was booked, so the retry path was never really tested. ` +
            `Agent said: "${first.body.output?.message}"`,
        ).toBe(1);
      } finally {
        created = [...created, ...proxy.appointmentIds];
        await proxy.close();
      }
    },
  );
});
