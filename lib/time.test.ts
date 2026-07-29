import { describe, expect, it } from 'vitest';
import { addDays, practiceDate } from './time';

/**
 * The API's date parameters are calendar days at the office, and the office is
 * in Denver. A UTC date is a different day there for six or seven hours out of
 * every twenty-four — long enough that an evening caller's availability search
 * would start from tomorrow, and "next Tuesday" would resolve a week out from
 * the wrong day.
 */

describe('practiceDate', () => {
  it('gives the practice-local day, not the UTC one', () => {
    // 01:30Z on the 30th is 7:30 PM on the 29th in Denver.
    const evening = new Date('2026-07-30T01:30:00Z');

    expect(evening.toISOString().slice(0, 10)).toBe('2026-07-30');
    expect(practiceDate(evening)).toBe('2026-07-29');
  });

  it('agrees with UTC during the working day', () => {
    expect(practiceDate(new Date('2026-07-29T16:00:00Z'))).toBe('2026-07-29');
  });

  it('is a plain YYYY-MM-DD, which is what the API takes', () => {
    expect(practiceDate(new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
  });
});

describe('addDays', () => {
  it('counts calendar days', () => {
    expect(addDays('2026-07-29', 60)).toBe('2026-09-27');
    expect(addDays('2026-07-29', 0)).toBe('2026-07-29');
  });

  it('crosses months and years', () => {
    expect(addDays('2026-12-20', 20)).toBe('2027-01-09');
  });

  it('does not drift over a daylight-saving boundary', () => {
    // Denver springs forward on 2026-03-08. A window computed with a clock
    // rather than a calendar lands a day out here.
    expect(addDays('2026-03-01', 14)).toBe('2026-03-15');
    expect(addDays('2026-10-25', 14)).toBe('2026-11-08');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
