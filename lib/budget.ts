import {
  MIN_AGENT_MS,
  REDIS_OP_TIMEOUT_MS,
  REQUEST_BUDGET_MS,
  TURN_DEADLINE_MS,
} from './config';

/**
 * How a request's twenty seconds get divided.
 *
 * Kept apart from the route because the arithmetic is the whole point and it is
 * easy to get subtly wrong: the protocol counts from when the evaluator sends,
 * so parsing, the shared-store reads before the model and the writes after it
 * are all spent from the same allowance. A deadline that starts when the model
 * does looks generous and is not.
 *
 * Both functions take the elapsed time rather than reading a clock, so the
 * division can be tested at the boundaries instead of inferred from a log.
 */

/** Shared-store writes that must still happen after the agent stops. */
const WRITES_AFTER_WORK = 2;

/**
 * The abort deadline for agent work, given how long the request has already
 * taken.
 *
 * Slow Redis therefore eats agent time rather than the protocol's headroom —
 * the agent is the part that degrades gracefully, because a turn cut short
 * still answers the patient with a real sentence.
 */
export function agentBudgetMs(elapsedMs: number): number {
  const left = REQUEST_BUDGET_MS - elapsedMs - WRITES_AFTER_WORK * REDIS_OP_TIMEOUT_MS;
  return Math.max(MIN_AGENT_MS, Math.min(TURN_DEADLINE_MS, left));
}

/**
 * How long an instance that lost the claim may wait for the winner's answer.
 *
 * Never past the request's own allowance: the winner's turn is worthless if it
 * arrives after the evaluator has given up, and a timeout ends the whole run
 * rather than just this turn.
 */
export function waitBudgetMs(elapsedMs: number): number {
  return Math.max(0, REQUEST_BUDGET_MS - elapsedMs);
}
