import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EVALUATOR_TIMEOUT_MS } from '../lib/config';
import { sendTurn } from './support/protocol';
import { startProxy } from './support/proxy';
import { AGENT_URL, apiConfig, cleanup } from './support/run';
import { confirmationMessage } from './support/said';
import { fetchAppointments } from './support/verify';

/**
 * The heaviest legitimate turn: one message that has to run the whole booking
 * chain — services, patient, insurance, availability, hold, confirm — before the
 * agent can say anything true.
 *
 * Why this is not covered by the deadline spec next door: that one proves the
 * abort works when a turn *cannot* finish in time. This one proves a realistic
 * turn does not need it. Both matter, and they fail in opposite directions — a
 * turn that quietly falls back to "call the office" on every real booking passes
 * every conformance check in the suite while scoring nothing.
 *
 * The existing conformance timing check uses a question answerable from
 * `/practice`, which costs one call and proves nothing about headroom.
 */

let created: string[] = [];

afterEach(async () => {
  await cleanup(created);
  created = [];
});

/** Everything the agent needs, so nothing is waiting on the patient. */
const ONE_SHOT =
  'Hi, I need to book a cleaning. I am a returning patient: Rita Reed, date ' +
  'of birth 1985-03-15, phone 555-222-3333, email rita.reed@example.com. I ' +
  'will self-pay, no insurance. Please book the earliest available slot — I ' +
  'do not need to see the options first, just take the first one and confirm it.';

/**
 * Ceiling on API calls for a single booking turn.
 *
 * Six is the whole chain and what this turn actually costs today: services,
 * patient, insurance, availability, hold, confirm. Three spare allow a payer
 * lookup and a widened availability search or two. Past that the agent is
 * re-fetching static catalogs it already holds, which is how a metered key runs
 * dry on a later turn that did nothing wrong.
 */
const CALL_CEILING = 9;

describe('a full booking in one turn', () => {
  it(
    'completes the whole chain inside the evaluator deadline',
    { timeout: 120_000 },
    async () => {
      const { baseUrl, apiKey } = apiConfig();
      const proxy = await startProxy({
        target: baseUrl,
        scenario: 'heavy',
        maxBookings: 1,
      });

      try {
        const started = Date.now();

        const { status, body } = await sendTurn({
          agentUrl: AGENT_URL,
          runId: `e2e-heavy-${randomUUID()}`,
          message: ONE_SHOT,
          dentalApi: { base_url: proxy.origin, api_key: apiKey },
        });

        const elapsed = Date.now() - started;
        created = proxy.appointmentIds;

        expect(status).toBe(200);
        expect(body.output?.message?.trim()).toBeTruthy();

        // The protocol's hard limit. Past this the run ends as a candidate
        // endpoint error rather than a scheduling failure.
        expect(
          elapsed,
          `the turn took ${(elapsed / 1000).toFixed(1)}s, past the evaluator's ` +
            `${EVALUATOR_TIMEOUT_MS / 1000}s limit`,
        ).toBeLessThan(EVALUATOR_TIMEOUT_MS);

        // Ground truth: a plausible sentence is not a booking.
        expect(
          proxy.appointmentIds,
          `no appointment was created in ${(elapsed / 1000).toFixed(1)}s. ` +
            `Agent said: "${body.output?.message}"`,
        ).toHaveLength(1);

        const [appt] = await fetchAppointments(proxy.appointmentIds);
        expect(appt.status).toBe('confirmed');

        // The turn finished on its own rather than being rescued by the internal
        // deadline. Stated as positive evidence — the reply names the
        // appointment that exists — because the deadline's fallback is itself a
        // well-formed, on-time sentence. Checking for the fallback's words
        // instead would miss the nastier variant this catches: the booking
        // landing while the patient is told to ring the office.
        expect(
          confirmationMessage(
            [{ role: 'agent', content: body.output?.message ?? '' }],
            appt,
          ),
          `the booking chain did not report back in ` +
            `${(elapsed / 1000).toFixed(1)}s. An appointment exists ` +
            `(${appt.starts_at} UTC with ${appt.provider.name}) but the reply ` +
            `was: "${body.output?.message}"`,
        ).toBeDefined();

        // Budget discipline, measured where it is worst: the turn that does
        // everything. Static catalogs should be fetched once, not per step.
        const breakdown = proxy.calls
          .map((c) => `${c.method} ${c.route} → ${c.status}`)
          .join('\n  ');

        console.log(
          `▸ one-turn booking: ${(elapsed / 1000).toFixed(1)}s, ` +
            `${proxy.calls.length} API calls\n  ${breakdown}`,
        );

        expect(
          proxy.calls.length,
          `the turn spent ${proxy.calls.length} API calls on one booking ` +
            `(ceiling ${CALL_CEILING}):\n  ${breakdown}`,
        ).toBeLessThanOrEqual(CALL_CEILING);
      } finally {
        created = [...new Set([...created, ...proxy.appointmentIds])];
        await proxy.close();
      }
    },
  );
});
