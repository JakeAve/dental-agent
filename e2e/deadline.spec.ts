import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sendTurn } from './support/protocol';
import { startProxy } from './support/proxy';
import { AGENT_URL, apiConfig, cleanup } from './support/run';

/**
 * The protocol's least-obvious requirement: *"Stop background work when the
 * turn ends."*
 *
 * A `Promise.race` deadline satisfies the visible half of this — the evaluator
 * gets an answer in time — while violating the invisible half, because the loop
 * carries on calling the scheduling API on a key with a finite call budget.
 * Nothing in a normal run surfaces that; the turn looks fine and the budget is
 * simply gone later, on a turn that had nothing to do with it.
 *
 * The proxy makes it visible. Every upstream call is stamped with its arrival
 * time, so "did any request start after we replied?" is a real assertion.
 */

let created: string[] = [];

afterEach(async () => {
  await cleanup(created);
  created = [];
});

/** Long enough that any straggler would land inside it. */
const OBSERVATION_MS = 8_000;

describe('turn deadline', () => {
  it(
    'stops calling the scheduling API once the turn has been answered',
    { timeout: 120_000 },
    async () => {
      const { baseUrl, apiKey } = apiConfig();

      // Every upstream call takes 4s. A booking request needs several in
      // sequence, so the turn cannot finish inside its 16s deadline — the
      // abort path runs for real, with no product code modified to force it.
      const proxy = await startProxy({
        target: baseUrl,
        scenario: 'deadline',
        maxBookings: 1,
        delayMs: 4_000,
      });

      try {
        const response = await sendTurn({
          agentUrl: AGENT_URL,
          runId: `e2e-deadline-${randomUUID()}`,
          message:
            'Hi, I need to book a cleaning. I am a returning patient: Rita ' +
            'Reed, date of birth 1985-03-15, phone 555-222-3333, email ' +
            'rita.reed@example.com. I will self-pay. Please book the first ' +
            'available slot.',
          dentalApi: { base_url: proxy.origin, api_key: apiKey },
        });

        const answeredAt = Date.now();

        // The turn still has to be well-formed: a deadline is not an excuse to
        // return an error or an empty message to the synthetic patient.
        expect(response.status).toBe(200);
        expect(response.body.output?.message?.trim()).toBeTruthy();

        // Nothing was raced past the evaluator's own 20s limit.
        expect(response.body.status).toBe('continue');

        const before = proxy.calls.length;
        expect(
          before,
          'the proxy was never called — the turn did not exercise the API at all',
        ).toBeGreaterThan(0);

        await new Promise((r) => setTimeout(r, OBSERVATION_MS));

        const stragglers = proxy.calls.filter((c) => c.at > answeredAt);

        expect(
          stragglers,
          `the agent made ${stragglers.length} scheduling call(s) after the ` +
            `turn was answered: ${stragglers
              .map((c) => `${c.method} ${c.route}`)
              .join(', ')}. Background work is not being cancelled, and each ` +
            'of these spends from the run-scoped call budget.',
        ).toHaveLength(0);

        created = proxy.appointmentIds;
      } finally {
        created = [...created, ...proxy.appointmentIds];
        await proxy.close();
      }
    },
  );
});
