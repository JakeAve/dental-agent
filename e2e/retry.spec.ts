import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sharedStoreFromEnv } from '../lib/idempotency';
import { deserializeRun } from '../lib/run-store';
import { sendTurn } from './support/protocol';
import { startProxy } from './support/proxy';
import { AGENT_URL, apiConfig, cleanup } from './support/run';

/**
 * The protocol's idempotency rule, on the path that used to break it: *"A
 * transport retry repeats the same IDs and must not create a duplicate
 * conversational action or booking."*
 *
 * A turn that answers normally is easy — the answer is saved and replayed. The
 * hard case is a turn that *failed*. The fallback is deliberately not saved, so
 * a retry gets a genuine second attempt rather than a permanent apology; the
 * danger is that the second attempt does not know what the first one already
 * did. Registering the patient is the cheapest visible instance of that: it
 * happens early, it succeeds before the deadline fires, and doing it twice
 * leaves two records in a sandbox the evaluator inspects directly.
 *
 * Deliberately not booking anything. The first turn is stalled to death long
 * before it reaches a hold, which keeps the shared sandbox clean while still
 * exercising the abort path for real.
 */

let created: string[] = [];

afterEach(async () => {
  await cleanup(created);
  created = [];
});

const PATIENTS = '/api/v1/patients';

const registered = (calls: Array<{ method: string; route: string; status: number }>) =>
  calls.filter((c) => c.method === 'POST' && c.route === PATIENTS && c.status < 300);

describe('retry after a failed turn', () => {
  it(
    'does not register the patient a second time',
    { timeout: 180_000 },
    async () => {
      const { baseUrl, apiKey } = apiConfig();
      const runId = `e2e-retry-${randomUUID()}`;
      const turnId = randomUUID();

      // A fresh identity per run: a persistent sandbox would otherwise let a
      // previous run's record stand in for this one's and hide a duplicate.
      const suffix = randomUUID().slice(0, 8);
      // A real 10-digit number, or the agent quite rightly asks for one again
      // and never reaches registerPatient.
      const line = randomUUID().replace(/\D/g, '').padEnd(4, '7').slice(0, 4);
      // Returning, not new: a new patient needs an address and an emergency
      // contact, and the turn would spend its life asking for them instead of
      // reaching registerPatient.
      const message =
        'Hi, I need a cleaning. I am a returning patient: Nadia Fournier, date ' +
        `of birth 1991-07-02, phone 555-441-${line}, email ` +
        `nadia.${suffix}@example.com. I will self-pay. What times do you have?`;

      // Every upstream call takes 4s, so the turn cannot finish inside its 16s
      // deadline. The abort path runs for real, with no product code changed.
      const stalled = await startProxy({
        target: baseUrl,
        scenario: 'retry-stalled',
        maxBookings: 0,
        delayMs: 4_000,
      });

      // The retry's view of the API: same sandbox, no stall, its own ledger of
      // calls — which is what makes "did it register again?" answerable.
      const healthy = await startProxy({
        target: baseUrl,
        scenario: 'retry-healthy',
        maxBookings: 1,
      });

      try {
        const first = await sendTurn({
          agentUrl: AGENT_URL,
          runId,
          turnId,
          message,
          dentalApi: { base_url: stalled.origin, api_key: apiKey },
        });

        expect(first.status).toBe(200);
        expect(first.body.output?.message?.trim()).toBeTruthy();

        // The precondition, asserted rather than assumed: this test only means
        // something if the doomed turn got as far as creating the patient.
        expect(
          registered(stalled.calls).length,
          'the stalled turn never registered the patient, so a retry has ' +
            'nothing to duplicate — the delay may need raising, or the agent ' +
            'is now asking a question before it registers anyone. It called: ' +
            `${stalled.calls.map((c) => `${c.method} ${c.route} → ${c.status}`).join(', ') || 'nothing'}` +
            `. It replied: "${first.body.output?.message}"`,
        ).toBe(1);

        // The in-process leg of this is easy to satisfy by accident: the tools
        // mutate a session the next request on the same instance still holds.
        // What the retry actually depends on — and what a cold instance would
        // have nothing else to go on — is that the failed turn published that
        // session before releasing its claim. Read straight out of the shared
        // store, because "another instance would have seen this" is the claim.
        const shared = sharedStoreFromEnv();
        expect(
          shared,
          'no Redis configured, so the cross-instance half of this test cannot ' +
            'run. Set KV_REST_API_URL / KV_REST_API_TOKEN.',
        ).not.toBeNull();

        const published = deserializeRun(await shared!.loadRun(runId));

        expect(
          published?.session.patient?.id,
          'the failed turn did not publish its session, so a retry landing on ' +
            'any other instance would register the patient a second time.',
        ).toBeTruthy();

        const retry = await sendTurn({
          agentUrl: AGENT_URL,
          runId,
          turnId,
          message,
          dentalApi: { base_url: healthy.origin, api_key: apiKey },
        });

        expect(retry.status).toBe(200);
        expect(retry.body.turn_id).toBe(turnId);
        expect(retry.body.output?.message?.trim()).toBeTruthy();

        expect(
          registered(healthy.calls).length,
          'the retry registered the patient again: ' +
            `${registered(healthy.calls).length} POST ${PATIENTS}. The first ` +
            'attempt already created a record, so the run now holds two ' +
            'patients for one person.',
        ).toBe(0);
      } finally {
        created = [...stalled.appointmentIds, ...healthy.appointmentIds];
        await Promise.all([stalled.close(), healthy.close()]);
      }
    },
  );
});
