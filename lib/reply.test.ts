import { describe, expect, it } from 'vitest';
import {
  awaitingReply,
  capMessage,
  collapseRestartedReply,
  MAX_MESSAGE_BYTES,
} from './reply';

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

/**
 * The protocol's 256 KiB is not a quality bar but a run-ending one: an
 * oversized body is scored as a candidate-endpoint error, so every turn that
 * went well before it is lost with it.
 */
describe('capMessage', () => {
  it('leaves a normal reply exactly as it is', () => {
    const reply = 'You are booked for Thursday, July 30 at 9:00 AM with Dr Chen.';
    expect(capMessage(reply)).toBe(reply);
  });

  it('passes a long-but-sane reply through untouched', () => {
    // Far longer than anything a receptionist would say, still nowhere near
    // the ceiling — the cap must not be trimming real answers.
    const reply = 'Here are the times I have. '.repeat(200);
    expect(capMessage(reply)).toBe(reply);
  });

  it('brings a runaway reply under the ceiling', () => {
    const runaway = 'x'.repeat(MAX_MESSAGE_BYTES * 3);
    const capped = capMessage(runaway);

    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(
      MAX_MESSAGE_BYTES,
    );
    expect(capped.length).toBeLessThan(runaway.length);
  });

  it('counts bytes rather than characters, and splits no character in half', () => {
    // Four bytes each: a cap measured in characters would let this through at
    // four times the intended size, and a naive byte slice would cut one in two.
    const emoji = '🦷'.repeat(MAX_MESSAGE_BYTES);
    const capped = capMessage(emoji);

    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(
      MAX_MESSAGE_BYTES,
    );
    expect(capped).not.toContain('�');
    expect([...capped].every((c) => c === '🦷' || c === '…')).toBe(true);
  });

  it('never returns an empty message, which is its own violation', () => {
    expect(capMessage('x'.repeat(MAX_MESSAGE_BYTES + 1)).trim()).not.toBe('');
  });
});

describe('capMessage, at the boundary', () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s).length;

  it('stays under the ceiling for a reply that lands just over it', () => {
    // Two-byte characters with no spaces in the tail: the shape that used to
    // come out two bytes over, because the ellipsis costs three and only one
    // was reserved for it.
    for (const accented of [3275, 3276, 3277, 4000, 16000]) {
      const runaway = 'é'.repeat(accented) + 'x'.repeat(MAX_MESSAGE_BYTES);
      expect(bytesOf(capMessage(runaway))).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
  });

  it('never returns an empty message, whatever it was given', () => {
    for (const input of ['', '   ', '\n\n', ' '.repeat(MAX_MESSAGE_BYTES * 2)]) {
      expect(capMessage(input).trim()).not.toBe('');
    }
  });
});

/**
 * `complete` is reported when the run has resolved and nothing is outstanding.
 * A question mark is not the only way of leaving something outstanding — this
 * was found by driving the deployed agent through a booking and then a
 * cancellation, where turn 4 asked for a confirmation and reported itself done.
 */
describe('awaitingReply', () => {
  it('recognises a request for confirmation with no question mark in it', () => {
    // Verbatim from production.
    expect(
      awaitingReply(
        'Sure — I can cancel the Adult Cleaning on Thursday, July 30, 2026 at ' +
          '9:00 AM MDT with Maria Gonzalez RDH.\n\nPlease confirm you want me ' +
          'to cancel that appointment.',
      ),
    ).toBe(true);
  });

  it('recognises an ordinary question', () => {
    expect(awaitingReply('Are you a new or returning patient?')).toBe(true);
  });

  it('recognises the other ways of asking', () => {
    for (const asking of [
      'Let me know which time suits you.',
      'Please let me know if that works.',
      'Tell me which day you prefer.',
      "I'll need your member ID to check that.",
    ]) {
      expect(awaitingReply(asking), asking).toBe(true);
    }
  });

  it('leaves a finished answer finished', () => {
    for (const done of [
      "You're booked for Thursday, July 30, 2026 at 9:00 AM MDT with Maria Gonzalez RDH.",
      'Cancelled — the Adult Cleaning on Thursday has been removed.',
      "We're open Monday through Friday, 8:00 AM to 5:00 PM.",
    ]) {
      expect(awaitingReply(done), done).toBe(false);
    }
  });
});
