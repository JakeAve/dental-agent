import { describe, expect, it } from 'vitest';
import { collapseRestartedReply } from './reply';

// Both duplicated samples below are verbatim captures from gpt-5.4-mini via
// runAgentOnce on 2026-07-29 — the model restarted its reply inside a single
// completion string.

const exactRestart =
  'Tomorrow is Thursday, July 30, 2026. What kind of visit are you looking for: a routine exam/cleaning, or is it for a specific dental problem?\n' +
  'Tomorrow is Thursday, July 30, 2026. What kind of visit are you looking for: a routine exam/cleaning, or is it for a specific dental problem?';

const rewrittenRestart =
  'Tomorrow is Thursday, July 30, 2026. For availability, I just need to know whether you’re a new patient or have been here before, and whether you’re looking for an exam/cleaning or you have a specific dental concern.\n' +
  'Tomorrow is Thursday, July 30, 2026.\n\n' +
  'For availability, I just need to know:\n' +
  '- have you been here before, or are you a new patient?\n' +
  '- are you looking for a routine visit like an exam/cleaning, or do you have a specific dental concern?';

describe('collapseRestartedReply', () => {
  it('collapses an exact restart to a single copy', () => {
    expect(collapseRestartedReply(exactRestart)).toBe(
      'Tomorrow is Thursday, July 30, 2026. What kind of visit are you looking for: a routine exam/cleaning, or is it for a specific dental problem?',
    );
  });

  it('keeps the final draft of a rewritten restart', () => {
    expect(collapseRestartedReply(rewrittenRestart)).toBe(
      'Tomorrow is Thursday, July 30, 2026.\n\n' +
        'For availability, I just need to know:\n' +
        '- have you been here before, or are you a new patient?\n' +
        '- are you looking for a routine visit like an exam/cleaning, or do you have a specific dental concern?',
    );
  });

  it('leaves an ordinary reply alone', () => {
    const text =
      'The first opening I found is Wednesday, August 5, 2026 at 3:30 PM MDT with Tom Becker RDH, and the self-pay price is $125.00.';
    expect(collapseRestartedReply(text)).toBe(text);
  });

  it('leaves a short closing restatement alone', () => {
    const text =
      'Your cleaning is booked for Wednesday at 3:30 PM.\n' +
      'We ask that you arrive ten minutes early, bring a photo ID, and let us know if anything changes — cancellations within 24 hours may carry a fee, so please call the office if you need to move it.\n' +
      'Your cleaning is booked for Wednesday at 3:30 PM.';
    expect(collapseRestartedReply(text)).toBe(text);
  });

  it('leaves short messages alone', () => {
    expect(collapseRestartedReply('Sure!')).toBe('Sure!');
    expect(collapseRestartedReply('Done. Anything else?\nDone.')).toBe(
      'Done. Anything else?\nDone.',
    );
  });
});
