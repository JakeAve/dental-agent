import { describe, expect, it } from 'vitest';
import { normalizeDateOfBirth, normalizePhone } from './patients';

/**
 * Patients say phone numbers and birthdays the way people say them, but the API
 * accepts exactly `555-555-5555` and `YYYY-MM-DD`. Without reshaping, every
 * spoken variant 422s and the agent responds by asking the patient to repeat a
 * number it already heard correctly.
 *
 * The line these tests pin: reformat freely, never change which digits were
 * given. A number with the wrong number of digits comes back null so the caller
 * asks, because padding or truncating invents a stranger's phone number.
 */

describe('normalizePhone', () => {
  it.each([
    ['555-555-0142', '555-555-0142'],
    ['(555) 555 0142', '555-555-0142'],
    ['5555550142', '555-555-0142'],
    ['555.555.0142', '555-555-0142'],
    ['  555 555 0142  ', '555-555-0142'],
    ['+1 (555) 555-0142', '555-555-0142'],
    ['1-555-555-0142', '555-555-0142'],
  ])('reformats %j', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['555-0142'], // 7-digit local number: area code genuinely missing
    ['555 555 0142 ext 12'], // trailing extension makes the digits ambiguous
    ['555-555-014'],
    [''],
    ['five five five'],
  ])('refuses to guess at %j', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe('normalizeDateOfBirth', () => {
  it.each([
    ['1988-08-02', '1988-08-02'],
    ['8/2/1988', '1988-08-02'],
    ['08/02/1988', '1988-08-02'],
    ['8-2-1988', '1988-08-02'],
    ['12/31/1955', '1955-12-31'],
  ])('reformats %j', (input, expected) => {
    expect(normalizeDateOfBirth(input)).toBe(expected);
  });

  it.each([
    ['8/2/88'], // two-digit year: 1988 or 2088?
    ['13/2/1988'], // not a month
    ['August 2 1988'],
    [''],
  ])('refuses to guess at %j', (input) => {
    expect(normalizeDateOfBirth(input)).toBeNull();
  });
});
