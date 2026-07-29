import { CedarRidgeError } from '../cedar-ridge';
import { PRACTICE } from '../config';

/**
 * Turns a thrown API error into a tool result the model can act on.
 *
 * Two reasons this exists rather than letting the error propagate:
 *
 * 1. A raw throw surfaces `POST /holds → 409: {"error":…}` into the transcript.
 *    Invariant 11 of the test plan: no status codes or stack traces in
 *    customer-facing text.
 * 2. Most of these failures are recoverable, but only if the model is told how.
 *    `SLOT_TAKEN` means re-search, `HOLD_EXPIRED` means re-hold — the model
 *    guesses badly when handed only a code.
 */

type Recovery = {
  /** What the model should say happened, in plain language. */
  problem: string;
  /** What to do next. */
  guidance: string;
  /** False when retrying is pointless and the front desk is the answer. */
  recoverable: boolean;
};

const FRONT_DESK =
  'Apologize, tell the patient the scheduling system is unavailable, and give ' +
  `them the office number, ${PRACTICE.phone}.`;

function recoveryFor(err: CedarRidgeError): Recovery {
  switch (err.code) {
    case 'INSURANCE_REQUIRED':
      return {
        problem: 'Availability cannot be searched until insurance is settled.',
        guidance:
          'Call verifyInsurance first — either payerId plus memberId, or ' +
          'selfPay true if they have no insurance or would rather not use it. ' +
          'Then retry this search.',
        recoverable: true,
      };

    case 'SLOT_TAKEN':
    case 'SLOT_UNAVAILABLE':
      return {
        problem: 'That time was taken by someone else before it was reserved.',
        guidance:
          'Do not offer it again. Call findAvailability for fresh times, ' +
          'apologize briefly, and offer the nearest alternatives.',
        recoverable: true,
      };

    case 'HOLD_EXPIRED':
      return {
        problem: 'The five-minute hold lapsed before the booking was confirmed.',
        guidance:
          'Search availability again — the slot may still be free. Take a new ' +
          'hold and confirm it promptly rather than gathering more details first.',
        recoverable: true,
      };

    case 'HOLD_ALREADY_USED':
      return {
        problem:
          'That hold was already consumed, or was superseded by a newer hold.',
        guidance:
          'The booking may have gone through. Do NOT blindly re-book — that ' +
          'risks a duplicate. If you have an appointmentId, confirm it with ' +
          'getAppointment. Otherwise take a fresh hold on a current slot.',
        recoverable: true,
      };

    case 'VALIDATION_FAILED': {
      const fields = Object.keys(err.details ?? {});
      return {
        problem: fields.length
          ? `The record was rejected: ${fields.join(', ')}.`
          : 'The record was rejected as incomplete.',
        guidance:
          'Ask the patient for the missing or corrected values and call again. ' +
          'Never invent a value to satisfy a required field.',
        recoverable: true,
      };
    }

    case 'PAYER_UNKNOWN':
      return {
        problem: 'That insurer is not one the system recognizes.',
        guidance:
          'Call listPayers and match what the patient said to a real payerId. ' +
          'If nothing matches, the practice does not work with them — offer ' +
          'self-pay.',
        recoverable: true,
      };

    case 'INVALID_SERVICE':
      return {
        problem: 'That is not a service code this practice offers.',
        guidance: 'Call listServices and pick the code that fits their need.',
        recoverable: true,
      };

    case 'NOT_FOUND':
      return {
        problem: 'No record exists with that id.',
        guidance:
          'Do not assume the record exists. Re-check the id you were given, ' +
          'or ask the patient to confirm their details.',
        recoverable: true,
      };

    case 'RATE_LIMITED':
      return {
        problem: 'The scheduling system is refusing further requests right now.',
        guidance: FRONT_DESK + ' Do not retry in a loop.',
        recoverable: false,
      };

    case 'UNAUTHORIZED':
      return {
        problem: 'This session is not authorized to reach the scheduling system.',
        guidance: FRONT_DESK,
        recoverable: false,
      };

    default:
      return {
        problem: 'The scheduling system returned an unexpected error.',
        guidance:
          'Try once more if it seems transient. ' + FRONT_DESK,
        recoverable: false,
      };
  }
}

export type ToolFailure = Recovery & { ok: false };

/**
 * Wraps a tool body so API failures come back as data instead of exceptions.
 * Anything that is not a CedarRidgeError is genuinely unexpected and rethrown.
 */
export async function withRecovery<T>(
  fn: () => Promise<T>,
  label = 'tool',
): Promise<T | ToolFailure> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CedarRidgeError) {
      // Code and field names only — never values, which carry patient data.
      console.warn(
        `[${label}] ${err.code} (${err.status})` +
          (Object.keys(err.details ?? {}).length
            ? ` fields=[${Object.keys(err.details).join(', ')}]`
            : ''),
      );
      return { ok: false, ...recoveryFor(err) };
    }
    throw err;
  }
}
