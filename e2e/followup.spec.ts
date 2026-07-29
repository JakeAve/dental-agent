import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sendTurn, type TurnResponse } from './support/protocol';
import { startProxy } from './support/proxy';
import { statesTime } from './support/said';
import { AGENT_URL, apiConfig, cleanup } from './support/run';
import { fetchAppointment } from './support/verify';

/**
 * The protocol's post-completion clause:
 *
 *   "Use status: 'complete' when the agent believes the conversation is
 *    finished. The evaluator may still send a later turn in the same run_id
 *    when a scripted patient question was waiting to be delivered, so keep
 *    the run state available and handle that follow-up normally."
 *
 * An agent that drops or resets its run state on `complete` passes every other
 * test in this suite and still fails a real evaluation the moment a scripted
 * question lands after the booking. So: book for real, reach `complete`, then
 * deliver exactly that late question and require a normal answer — one that
 * states the actual booked time, from state, without booking anything else.
 */

let created: string[] = [];

afterEach(async () => {
  await cleanup(created);
  created = [];
});

describe('follow-up after complete', () => {
  it(
    'keeps run state and answers a turn sent after status "complete"',
    { timeout: 180_000 },
    async () => {
      const { baseUrl, apiKey } = apiConfig();

      const proxy = await startProxy({
        target: baseUrl,
        scenario: 'followup',
        maxBookings: 1,
      });

      const runId = `e2e-followup-${randomUUID()}`;
      const dentalApi = { base_url: proxy.origin, api_key: apiKey };
      const transcript: string[] = [];

      try {
        // Scripted, not synthetic-patient-driven: every fact the agent needs
        // is in turn one, and every later turn is consent. Deterministic, and
        // the booking itself is already covered by outcomes.spec.ts.
        let message =
          'Hi, I need to book a cleaning. I am a returning patient: Rita ' +
          'Reed, date of birth 1985-03-15, phone 555-222-3333, email ' +
          'rita.reed@example.com. I will self-pay. Please book the first ' +
          'available slot — any weekday time works for me.';

        let last: TurnResponse | undefined;

        for (let turn = 1; turn <= 6; turn++) {
          last = await sendTurn({
            agentUrl: AGENT_URL,
            runId,
            turnNumber: turn,
            message,
            dentalApi,
          });

          expect(last.status).toBe(200);
          transcript.push(
            `PATIENT: ${message}`,
            `AGENT  : ${last.body.output?.message}`,
          );

          if (last.body.status === 'complete') break;
          message = 'Yes, that works — please book it.';
        }

        created = [...proxy.appointmentIds];
        const ctx = '\n' + transcript.join('\n') + '\n';

        expect(
          last?.body.status,
          `never reached "complete" within six turns.${ctx}`,
        ).toBe('complete');
        expect(
          proxy.appointmentIds,
          `said "complete" without exactly one real booking.${ctx}`,
        ).toHaveLength(1);

        // The evaluator's scripted question, delivered after completion.
        const followUp = await sendTurn({
          agentUrl: AGENT_URL,
          runId,
          message: 'Sorry, one more thing — what day and time did we settle on?',
          dentalApi,
        });

        expect(followUp.status).toBe(200);

        const reply = followUp.body.output?.message ?? '';
        expect(
          reply.trim(),
          `empty reply to the post-complete turn.${ctx}`,
        ).toBeTruthy();
        expect(['continue', 'complete']).toContain(followUp.body.status);

        // "Handle that follow-up normally" means the real answer: the booked
        // day and time as the API records them, not a shrug or a fresh intake.
        const appt = await fetchAppointment(proxy.appointmentIds[0]);
        expect(
          statesTime(reply, appt.starts_at),
          `follow-up reply did not state the booked time.\nREPLY: ${reply}${ctx}`,
        ).toBe(true);

        // Answered from run state — the follow-up must not book again.
        expect(proxy.appointmentIds).toHaveLength(1);
        expect(proxy.refusedBookings).toBe(0);
      } finally {
        created = [...proxy.appointmentIds];
        await proxy.close();
      }
    },
  );
});
