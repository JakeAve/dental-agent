/**
 * Every tunable in one place.
 *
 * These were scattered across the agent, the route, the run store and the time
 * helpers. Anything you might reasonably want to change without reading the
 * code that uses it belongs here; anything derived from it does not.
 */

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

/**
 * Chat Completions, deliberately, not the Responses API.
 *
 * Responses refers back to earlier messages by server-side item id, which fails
 * outright on a Zero Data Retention org — the items are never stored, so turn 2
 * gets "item not found". We replay the whole conversation on every turn anyway
 * (see lib/run-store.ts), so a stateless endpoint is the honest fit.
 */
export const AGENT_MODEL = 'gpt-5.4-mini';

/**
 * Booking is a five-call sequence before the model can say anything useful, and
 * a recovery path can add several more. Too small a budget and it stops partway
 * and narrates instead of acting.
 */
export const STEP_BUDGET = 16;

/* ------------------------------------------------------------------ *
 * Evaluation protocol
 * ------------------------------------------------------------------ */

export const PROTOCOL_VERSION = 'candidate-agent/1';

/**
 * The evaluator's own limit. We must answer inside this or the run errors —
 * and not merely this turn: a timeout is scored as a candidate-endpoint
 * failure, which ends the whole run however well the booking went.
 */
export const EVALUATOR_TIMEOUT_MS = 20_000;

/**
 * What one request may spend end to end, measured from the moment it arrives.
 *
 * Everything else here is carved out of this rather than added to it. Budgets
 * that each look safe alone are how a request quietly exceeds the evaluator's
 * limit: the agent's deadline, the shared-store reads before it and the writes
 * after it are all real wall clock on the same twenty seconds.
 */
export const REQUEST_BUDGET_MS = 18_000;

/**
 * Ceiling on agent work. The real deadline is whatever is left of
 * `REQUEST_BUDGET_MS` when the model starts, which is normally this.
 */
export const TURN_DEADLINE_MS = 16_000;

/**
 * The least agent time worth starting on.
 *
 * Below this the turn cannot reach a useful answer, and spending the last of
 * the budget trying is how a slow request becomes a failed run instead of a
 * graceful apology.
 */
export const MIN_AGENT_MS = 2_000;

// Note: route `maxDuration` deliberately lives as a literal in each route file.
// Next analyses segment config statically and rejects imported values.

/* ------------------------------------------------------------------ *
 * Cross-instance idempotency (lib/idempotency.ts)
 * ------------------------------------------------------------------ */

/**
 * How long a claimed turn stays claimed. Longer than the evaluator's timeout
 * so a completed turn cannot be re-claimed and re-executed the moment it
 * finishes; short enough that a crashed instance frees the turn for a retry.
 */
export const LOCK_TTL_MS = EVALUATOR_TIMEOUT_MS + 5_000;

/** How often a losing instance polls for the winner's saved turn. */
export const TURN_WAIT_POLL_MS = 400;

/**
 * Ceiling on how long a losing instance waits for the winner's turn. The
 * effective wait is whatever is left of the request budget, for the same reason
 * the agent's deadline is: better a real sentence inside the evaluator's limit
 * than a timeout that ends the run.
 */
export const TURN_WAIT_DEADLINE_MS = TURN_DEADLINE_MS;

/**
 * Hard ceiling on a single shared-store call.
 *
 * Upstash retries network failures five times by default, backing off
 * exponentially — over ten seconds of sleeping inside a twenty-second budget,
 * spent before the model has been asked anything. Every method here already
 * fails open, so cutting a slow call short costs the same as an outage: the
 * per-instance behaviour we had before Redis existed. Waiting does not.
 */
export const REDIS_OP_TIMEOUT_MS = 700;

/* ------------------------------------------------------------------ *
 * Run store
 * ------------------------------------------------------------------ */

/** Evaluation runs are short. An hour is generous and keeps memory bounded. */
export const RUN_TTL_MS = 60 * 60 * 1000;

/** Hard cap on retained runs, as a backstop against unbounded growth. */
export const MAX_RUNS = 500;

/* ------------------------------------------------------------------ *
 * Browser chat
 * ------------------------------------------------------------------ */

/** Hand-testing sessions are long and idle. A day outlives a dev session. */
export const CHAT_TTL_MS = 24 * 60 * 60 * 1000;

/** Backstop against unbounded growth on a long-running dev server. */
export const MAX_CHATS = 50;

/* ------------------------------------------------------------------ *
 * Practice
 * ------------------------------------------------------------------ */

/**
 * Static facts about the office. Hardcoded rather than fetched because they
 * never change during a run, and because an agent that has to call a tool to
 * find the phone number will sometimes not bother — which is how a patient in
 * pain was once told to ring "[insert office number]".
 */
export const PRACTICE = {
  name: 'Cedar Ridge Family Dental',
  phone: '303-555-0142',
  address: '1450 Larimer Street, Denver, CO 80202',
  timezone: 'America/Denver',
  hours: 'Monday to Friday, 8:00am to 5:00pm',
} as const;

/* ------------------------------------------------------------------ *
 * Tool behaviour
 * ------------------------------------------------------------------ */

/** FAQ results handed to the model per search. */
export const FAQ_PAGE_SIZE = 5;

/**
 * How far out to widen an availability search when the first window comes back
 * empty. New-patient visits are long and their openings are scarce, so a short
 * window reads as "fully booked" when it is not.
 */
export const WIDENED_SEARCH_DAYS = 60;
