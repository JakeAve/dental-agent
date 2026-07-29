import { describe, expect, it } from 'vitest';
import { CedarRidgeError } from './cedar-ridge';
import { errorLabel } from './log';

/**
 * *"Never log or return the supplied Scheduling API key."* The key reaches this
 * process on every turn, so the test that matters is not that a particular
 * message is safe — it is that no message is logged at all.
 */

const KEY = 'cand_run_scoped_secret';

describe('errorLabel', () => {
  it('says what class of failure it was', () => {
    expect(errorLabel(new TypeError('x'))).toBe('TypeError');

    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    expect(errorLabel(aborted)).toBe('AbortError');
  });

  it('keeps the API error code, which comes from a closed set', () => {
    const err = new CedarRidgeError('HOLD_EXPIRED', 'That hold has expired.', 410, {});
    expect(errorLabel(err)).toBe('CedarRidgeError:HOLD_EXPIRED:410');
  });

  it('quotes no message, however the message was built', () => {
    // Every shape a leak has actually taken: a client echoing the request, a
    // library quoting a header, a bare string thrown from somewhere.
    const leaks: unknown[] = [
      new Error(`GET /api/v1/availability failed (Authorization: Bearer ${KEY})`),
      new CedarRidgeError('UNKNOWN', `upstream said ${KEY}`, 500, { key: KEY }),
      `redis: SET run { api_key: ${KEY} }`,
      { message: KEY },
    ];

    for (const leak of leaks) {
      expect(errorLabel(leak)).not.toContain(KEY);
      expect(errorLabel(leak)).not.toContain('Bearer');
    }
  });

  it('has something to say about a value that is not an error at all', () => {
    expect(errorLabel(undefined)).toBe('unknown error');
    expect(errorLabel(null)).toBe('unknown error');
    expect(errorLabel({ nope: true })).toBe('unknown error');
  });
});
