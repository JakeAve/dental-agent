import { describe, expect, it } from 'vitest';
import type { CedarRidgeClient } from '../cedar-ridge';
import { createSession } from '../session';
import { normalizeDateOfBirth, normalizePhone, patientTools } from './patients';

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

/**
 * What a registration hands back about the record it created.
 *
 * Asked what was on file, this agent has said "no last name on record" of a
 * record that read `Wren Wren`, and said it had no complete street address while
 * holding `slip B-14, Cherry Creek Marina`. Both were reassurances rather than
 * readings. Reading requires having the fields to read.
 */

function registrationApi(stored: { first_name: string; last_name: string }) {
  const api = {
    registerPatient: async () => ({
      id: 'patient-1',
      status: 'new' as const,
      ...stored,
      date_of_birth: '1990-06-11',
      phone: '555-318-4402',
      email: 'wren@example.com',
      insurance_status: 'unverified' as const,
    }),
  } as unknown as CedarRidgeClient;

  return api;
}

const register = (api: CedarRidgeClient, input: Record<string, unknown>) =>
  (
    patientTools(api, createSession()).registerPatient.execute as unknown as (
      input: unknown,
    ) => Promise<Record<string, unknown>>
  )(input);

const WREN = {
  status: 'new',
  first_name: 'Wren',
  last_name: 'Wren',
  date_of_birth: '1990-06-11',
  phone: '555-318-4402',
  email: 'wren@example.com',
  address_line1: 'slip B-14, Cherry Creek Marina',
  city: 'Denver',
  state: 'CO',
  zip: '80209',
  emergency_contact_name: 'Marisol Vega',
  emergency_contact_phone: '555-318-7781',
};

describe('what registration reports about the record', () => {
  it('hands back the names the API confirmed', async () => {
    const result = await register(
      registrationApi({ first_name: 'Wren', last_name: 'Wren' }),
      WREN,
    );

    expect(result.record).toMatchObject({ firstName: 'Wren', lastName: 'Wren' });
  });

  it('marks the address as submitted, since the API does not echo it', async () => {
    const result = await register(
      registrationApi({ first_name: 'Jordan', last_name: 'Rivera' }),
      { ...WREN, first_name: 'Jordan', last_name: 'Rivera' },
    );

    expect(result.record).toEqual({
      firstName: 'Jordan',
      lastName: 'Rivera',
      addressLine1AsSubmitted: 'slip B-14, Cherry Creek Marina',
    });
  });

  it('says nothing about how the fields were arrived at', async () => {
    // Deliberately no note blessing a repeated first name. The agent reached
    // that on its own for a patient who has one name, and a tool that
    // documents the manoeuvre offers it as a shortcut to a model that simply
    // has not asked yet.
    const result = await register(
      registrationApi({ first_name: 'Wren', last_name: 'Wren' }),
      WREN,
    );

    expect(result.nameNote).toBeUndefined();
  });
});
