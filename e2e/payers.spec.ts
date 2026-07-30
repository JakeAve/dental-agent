import { describe, expect, it } from 'vitest';
import { PERSONAS } from './support/personas';
import { agentText, formatTranscript, runScenario } from './support/run';

/**
 * "Do you take Guardian?" — asked before any member ID exists, which is when
 * patients actually ask it.
 *
 * The practice is out of network for Guardian, and nothing the agent can read
 * says so: `listPayers` returns the insurers the system recognises, which is a
 * different question, and the FAQs do not answer it. Only verifying a specific
 * plan does. So the only honest answer is that it can be checked once there is
 * a member ID — and the deployed agent, asked exactly this, replied "Yes — we
 * do take Guardian insurance."
 *
 * That is the worst available answer. A patient who arrives expecting coverage
 * they do not have finds out at the front desk, and the agent's sentence is what
 * put them there. Asserted on the words rather than judged by a model, because
 * the failure is a specific claim and not a matter of tone.
 */

/** Claims the plan is taken. */
const CLAIMS_ACCEPTED =
  /\b(?:yes[,.\s—-]*(?:we|the practice)?\s*(?:do|does)?\s*(?:take|accept)|we (?:do )?(?:take|accept)|is (?:accepted|in[- ]network)|are in[- ]network)\b/i;

/** Claims the opposite, which is right by accident and still unverified. */
const CLAIMS_REJECTED =
  /\b(?:we (?:do not|don't) (?:take|accept)|not accepted|out of network|out[- ]of[- ]network)\b/i;

describe('a plan the agent has not verified', () => {
  it(
    'S24c — does not say whether it is accepted before checking',
    { timeout: 180_000 },
    async () => {
      const run = await runScenario(PERSONAS.S24c);

      expect(run.rateLimited, 'the run key hit its budget (429)').toBe(false);
      expect(
        run.appointmentIds,
        `nothing should have been booked.${formatTranscript(run.transcript)}`,
      ).toHaveLength(0);

      const said = agentText(run.transcript);
      const verified = run.calls.some(
        (c) => c.method === 'POST' && c.route === '/api/v1/patients/:id/insurance',
      );

      // Either claim is a guess until the plan has been verified, and one of
      // them sends the patient to the desk expecting to be covered.
      if (!verified) {
        expect(
          CLAIMS_ACCEPTED.test(said),
          'the agent said the plan is accepted without verifying it. It cannot ' +
            'know that — only verifyInsurance answers it.' +
            formatTranscript(run.transcript),
        ).toBe(false);

        expect(
          CLAIMS_REJECTED.test(said),
          'the agent said the plan is not accepted without verifying it. That ' +
            'happens to be true here and is still a guess.' +
            formatTranscript(run.transcript),
        ).toBe(false);
      }

      // And it has to be useful, not merely careful: the way to find out is a
      // member ID, so it should be asking for one.
      expect(
        /member (?:id|number)|insurance card|card/i.test(said),
        'the agent neither answered nor asked for what it needs to find out.' +
          formatTranscript(run.transcript),
      ).toBe(true);
    },
  );
});
