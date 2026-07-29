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

/** The evaluator's own limit. We must answer inside this or the run errors. */
export const EVALUATOR_TIMEOUT_MS = 20_000;

/**
 * Our internal deadline, with headroom inside the evaluator's limit so we
 * answer with a real sentence rather than hanging and failing the turn.
 */
export const TURN_DEADLINE_MS = 16_000;

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
 * How long a losing instance waits before answering with the fallback.
 * Bounded by the internal turn deadline for the same reason it is: better a
 * real sentence inside the evaluator's limit than a timeout.
 */
export const TURN_WAIT_DEADLINE_MS = TURN_DEADLINE_MS;

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
