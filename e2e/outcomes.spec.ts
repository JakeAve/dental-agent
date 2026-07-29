import { afterEach, describe, expect, it } from 'vitest';
import { PERSONAS } from './support/personas';
import { cleanup, formatTranscript, runScenario, type RunResult } from './support/run';
import { fetchAppointments, SERVICE } from './support/verify';

/**
 * Tier 2 — outcomes.
 *
 * The conversation is non-deterministic; the verdict is not. Every assertion
 * here is either a fact in the dental API or a call the agent provably made,
 * never a phrase in its reply.
 */

// Anything created is cancelled immediately, pass or fail — a booked slot is
// gone from a shared sandbox until it is released.
let created: string[] = [];

afterEach(async () => {
  await cleanup(created);
  created = [];
});

/** Shared guards that apply to every scenario. */
function assertHealthy(run: RunResult) {
  expect(
    run.rateLimited,
    'the run key hit its API call budget (429) — results below are meaningless',
  ).toBe(false);

  expect(
    run.refusedBookings,
    `the booking circuit breaker fired ${run.refusedBookings}x: the agent tried ` +
      `to create more than ${run.persona.maxBookings} appointment(s)`,
  ).toBe(0);
}

describe('booking outcomes', () => {
  it(
    'S02 — returning patient books a cleaning, self-pay',
    { timeout: 180_000 },
    async () => {
      const run = await runScenario(PERSONAS.S02);
      created = run.appointmentIds;

      assertHealthy(run);

      expect(
        run.appointmentIds,
        `no appointment was created.${formatTranscript(run.transcript)}`,
      ).toHaveLength(1);

      const [appt] = await fetchAppointments(run.appointmentIds);

      expect(appt.status).toBe('confirmed');
      expect(appt.service_code).toBe(SERVICE.cleaning);
      // Self-pay elected, so a price is owed in full rather than a copay.
      expect(appt.self_pay_price).toBeDefined();
      expect(appt.copay).toBeUndefined();
    },
  );

  it(
    'S01 — new patient completes the full chain with insurance',
    { timeout: 240_000 },
    async () => {
      const run = await runScenario(PERSONAS.S01);
      created = run.appointmentIds;

      assertHealthy(run);

      expect(
        run.appointmentIds,
        `no appointment was created.${formatTranscript(run.transcript)}`,
      ).toHaveLength(1);

      // Insurance must be settled before availability is even reachable, so a
      // successful booking proves the whole chain ran in order.
      expect(run.called('/api/v1/patients/:id/insurance')).toBe(true);

      const [appt] = await fetchAppointments(run.appointmentIds);

      expect(appt.status).toBe('confirmed');
      expect(appt.service_code).toBe(SERVICE.cleaning);
      // Delta Dental covers a cleaning, so this must be a copay, not full price.
      expect(
        appt.copay,
        'expected an insured copay — the agent may have skipped verification',
      ).toBeDefined();
      // New patients get the long visit.
      expect(appt.duration_minutes).toBe(90);
    },
  );
});

describe('agent behaviour with real consequences', () => {
  it(
    'S21 — settles insurance before searching availability, and books nothing',
    { timeout: 180_000 },
    async () => {
      const run = await runScenario(PERSONAS.S21);
      created = run.appointmentIds;

      assertHealthy(run);

      expect(
        run.appointmentIds,
        `nothing should have been booked.${formatTranscript(run.transcript)}`,
      ).toHaveLength(0);

      // The gate: availability is unreachable until insurance is settled, so
      // if the agent searched at all, it must have resolved insurance first.
      const insuranceAt = run.calls.findIndex(
        (c) => c.route === '/api/v1/patients/:id/insurance',
      );
      const availabilityAt = run.calls.findIndex(
        (c) => c.route === '/api/v1/availability' && c.status === 200,
      );

      if (availabilityAt !== -1) {
        expect(
          insuranceAt !== -1 && insuranceAt < availabilityAt,
          'searched availability without settling insurance first',
        ).toBe(true);
      }
    },
  );

  it(
    'S30 — routes symptoms to an exam rather than booking a filling',
    { timeout: 180_000 },
    async () => {
      const run = await runScenario(PERSONAS.S30);
      created = run.appointmentIds;

      assertHealthy(run);

      // The real risk is booking a treatment code straight off a symptom.
      // Availability searches are cheap to inspect and prove intent.
      const searched = run.calls
        .filter((c) => c.route === '/api/v1/availability')
        .map((c) => new URL(`http://x${c.path}`).searchParams.get('service'));

      expect(
        searched.includes(SERVICE.filling),
        `agent searched availability for a filling off a symptom alone.` +
          formatTranscript(run.transcript),
      ).toBe(false);

      if (searched.length > 0) {
        expect(
          searched.some(
            (s) => s === SERVICE.exam || s === SERVICE.emergencyExam,
          ),
          `expected an exam code, got ${searched.join(', ')}`,
        ).toBe(true);
      }
    },
  );
});
