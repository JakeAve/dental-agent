import { describe, expect, it } from 'vitest';
import {
  createSession,
  describeSession,
  insuranceBlocks,
  type InsuranceStatus,
} from './session';

/**
 * The insurance gate, which the API and the scenario notes agree on and the
 * code did not: availability opens for `active`, `self_pay` *and*
 * `not_accepted`. An out-of-network plan is a settled answer — the practice
 * cannot bill it, so the visit is priced as self-pay and the patient may book.
 *
 * Blocking it stranded a patient behind a second conversion nothing asked for,
 * and recorded the run as self-pay when it was really an unaccepted plan, which
 * is the state the evaluator reads back.
 */

const withInsurance = (status: InsuranceStatus, planName?: string) => {
  const session = createSession();
  session.patient = { id: 'p1', name: 'Dana Reed', status: 'returning' };
  session.insurance = { status, planName };
  return session;
};

describe('insuranceBlocks', () => {
  it.each<[InsuranceStatus, boolean]>([
    ['active', false],
    ['self_pay', false],
    ['not_accepted', false],
    ['invalid_member', true],
    ['unverified', true],
  ])('%s blocks availability: %s', (status, blocked) => {
    expect(insuranceBlocks(withInsurance(status))).toBe(blocked);
  });

  it('blocks a patient whose insurance has not been touched at all', () => {
    expect(insuranceBlocks(createSession())).toBe(true);
  });
});

describe('describeSession, on an unaccepted plan', () => {
  const lines = describeSession(withInsurance('not_accepted', 'Guardian'));

  it('names the plan and says the question is settled', () => {
    expect(lines).toContain('Guardian');
    expect(lines).toMatch(/settled/i);
  });

  it('says what the patient will pay, since that is the surprise', () => {
    expect(lines).toMatch(/self-pay price/i);
  });

  it('does not send the agent off to elect self-pay instead', () => {
    expect(lines).toMatch(/nothing needs switching/i);
  });
});

describe('describeSession, on a member id that did not verify', () => {
  const lines = describeSession(withInsurance('invalid_member'));

  it('still says it is unsettled, because nothing was established', () => {
    expect(lines).toMatch(/NOT settled/);
  });
});
