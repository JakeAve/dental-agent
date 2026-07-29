import { describe, expect, it } from 'vitest';
import { agentBudgetMs, waitBudgetMs } from './budget';
import {
  EVALUATOR_TIMEOUT_MS,
  MIN_AGENT_MS,
  REDIS_OP_TIMEOUT_MS,
  REQUEST_BUDGET_MS,
  TURN_DEADLINE_MS,
} from './config';

/**
 * The protocol's twenty seconds are the run's life, not the turn's: *"timeouts
 * end the run as a candidate-endpoint or infrastructure error instead of an
 * evaluated scheduling failure."* So the arithmetic that keeps a request inside
 * them is worth pinning at the boundaries.
 */

describe('agentBudgetMs', () => {
  it('gives the full ceiling to a request that arrives promptly', () => {
    expect(agentBudgetMs(0)).toBe(TURN_DEADLINE_MS);
  });

  it('spends slow shared-store reads out of agent time, not the headroom', () => {
    const slow = 4_000;
    const budget = agentBudgetMs(slow);

    expect(budget).toBeLessThan(TURN_DEADLINE_MS);
    // The whole point: what the agent gets plus what has already gone plus the
    // writes still to come still fits inside the evaluator's limit.
    expect(slow + budget + 2 * REDIS_OP_TIMEOUT_MS).toBeLessThanOrEqual(
      EVALUATOR_TIMEOUT_MS,
    );
  });

  it('never asks the model to work in less time than is useful', () => {
    expect(agentBudgetMs(REQUEST_BUDGET_MS)).toBe(MIN_AGENT_MS);
    expect(agentBudgetMs(REQUEST_BUDGET_MS * 10)).toBe(MIN_AGENT_MS);
  });

  it('leaves room for the writes that follow the agent', () => {
    // At the point where the ceiling stops binding, the budget must still be
    // the remainder less the writes — not the remainder itself.
    const elapsed = REQUEST_BUDGET_MS - TURN_DEADLINE_MS;
    expect(agentBudgetMs(elapsed)).toBeLessThan(TURN_DEADLINE_MS);
  });
});

describe('waitBudgetMs', () => {
  it('offers what is left of the request', () => {
    expect(waitBudgetMs(0)).toBe(REQUEST_BUDGET_MS);
    expect(waitBudgetMs(5_000)).toBe(REQUEST_BUDGET_MS - 5_000);
  });

  it('never goes negative, which would read as an unbounded wait', () => {
    expect(waitBudgetMs(REQUEST_BUDGET_MS + 1_000)).toBe(0);
  });
});

describe('the budget as a whole', () => {
  it('stays inside the evaluator limit it is carved out of', () => {
    expect(REQUEST_BUDGET_MS).toBeLessThan(EVALUATOR_TIMEOUT_MS);
    // Enough slack left over to serialise and write the response body.
    expect(EVALUATOR_TIMEOUT_MS - REQUEST_BUDGET_MS).toBeGreaterThanOrEqual(1_000);
  });
});
