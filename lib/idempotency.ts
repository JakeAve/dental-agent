import { Redis } from '@upstash/redis';
import {
  LOCK_TTL_MS,
  REDIS_OP_TIMEOUT_MS,
  RUN_TTL_MS,
  TURN_WAIT_DEADLINE_MS,
  TURN_WAIT_POLL_MS,
} from './config';
import type { PersistedRun, Turn } from './run-store';

/**
 * The cross-instance half of the protocol's state requirements, backed by
 * Upstash Redis. Two jobs, both of which the in-memory maps in run-store can
 * only do per-process while Vercel routes requests wherever it likes.
 *
 * (run_id, turn_id) idempotency: four concurrent copies of one turn were
 * observed running on four instances, which on a booking turn means four
 * bookings. The first instance to claim a turn executes it; everyone else waits
 * for and replays the saved result.
 *
 * Run continuity: the session and message list a turn produced, so that turn 4
 * landing on a cold instance still knows the patient id, the offered slots and
 * the hold instead of rebuilding a thinner conversation from visible history.
 *
 * Every method fails open. Redis being unreachable must degrade to the
 * per-instance behaviour we had before, never take the turn down with it —
 * a duplicate booking is a scored failure, but so is a dead endpoint.
 */

/** The Upstash subset used here, injectable so tests need no network. */
export type RedisLike = {
  get<T>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    opts?: { nx?: true; px?: number },
  ): Promise<unknown>;
  del(key: string): Promise<number>;
};

export type SharedStore = {
  /** A turn another instance already finished, or null. */
  getTurn(runId: string, turnId: string): Promise<Turn | null>;
  /** True when this instance won the right to execute the turn. */
  claimTurn(runId: string, turnId: string): Promise<boolean>;
  /** Publish a finished turn for every other instance to replay. */
  saveTurn(runId: string, turnId: string, turn: Turn): Promise<void>;
  /**
   * Poll for the claim winner's result; null once the deadline passes.
   * `budgetMs` caps the wait at what the request has left to spend.
   */
  awaitTurn(runId: string, turnId: string, budgetMs?: number): Promise<Turn | null>;
  /** Free a failed turn's claim so a retry gets a real attempt. */
  releaseTurn(runId: string, turnId: string): Promise<void>;
  /**
   * The run's stored state, unvalidated — run-store owns the schema, so that
   * one module decides what a trustworthy run looks like.
   */
  loadRun(runId: string): Promise<unknown | null>;
  /** Publish the run's state for whichever instance takes the next turn. */
  saveRun(runId: string, run: PersistedRun): Promise<void>;
};

const turnKey = (runId: string, turnId: string) => `dental-agent:turn:${runId}:${turnId}`;
const lockKey = (runId: string, turnId: string) => `dental-agent:lock:${runId}:${turnId}`;
const runKey = (runId: string) => `dental-agent:run:${runId}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fails a call that has taken too long, so the caller's fail-open path runs.
 *
 * The timer is cleared either way: a pending one keeps the serverless process
 * alive past the response for no reason.
 */
function withTimeout<T>(work: Promise<T>, ms: number, op: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${op} exceeded ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function warn(op: string, err: unknown) {
  // Message only — never key material, and Redis errors can echo commands.
  console.warn(
    `[idempotency] ${op} failed open: ${err instanceof Error ? err.message : 'unknown error'}`,
  );
}

export function createSharedStore(
  redis: RedisLike,
  opts: {
    pollIntervalMs?: number;
    waitDeadlineMs?: number;
    opTimeoutMs?: number;
  } = {},
): SharedStore {
  const pollIntervalMs = opts.pollIntervalMs ?? TURN_WAIT_POLL_MS;
  const waitDeadlineMs = opts.waitDeadlineMs ?? TURN_WAIT_DEADLINE_MS;
  const opTimeoutMs = opts.opTimeoutMs ?? REDIS_OP_TIMEOUT_MS;

  /** Bounded, and failing open on the timeout exactly as on an outage. */
  const bounded = <T>(op: string, work: () => Promise<T>) =>
    withTimeout(work(), opTimeoutMs, op);

  const getTurn = async (runId: string, turnId: string) => {
    try {
      return await bounded('getTurn', () => redis.get<Turn>(turnKey(runId, turnId)));
    } catch (err) {
      warn('getTurn', err);
      return null;
    }
  };

  return {
    getTurn,

    async claimTurn(runId, turnId) {
      try {
        // The lock outlives the evaluator's timeout so a finished turn cannot
        // be claimed again the moment it completes; it expires on its own if
        // the winner dies without saving or releasing.
        const won = await bounded('claimTurn', () =>
          redis.set(lockKey(runId, turnId), '1', { nx: true, px: LOCK_TTL_MS }),
        );
        return won !== null;
      } catch (err) {
        warn('claimTurn', err);
        return true;
      }
    },

    async saveTurn(runId, turnId, turn) {
      try {
        await bounded('saveTurn', () =>
          redis.set(turnKey(runId, turnId), turn, { px: RUN_TTL_MS }),
        );
      } catch (err) {
        warn('saveTurn', err);
      }
    },

    async awaitTurn(runId, turnId, budgetMs) {
      // Whichever is shorter: this store's ceiling, or what the request has
      // left. Polling past the evaluator's limit turns a turn another instance
      // is about to answer into a failed run.
      const deadline = Date.now() + Math.min(waitDeadlineMs, budgetMs ?? waitDeadlineMs);
      while (Date.now() < deadline) {
        const turn = await getTurn(runId, turnId);
        if (turn) return turn;
        await sleep(pollIntervalMs);
      }
      return null;
    },

    async releaseTurn(runId, turnId) {
      try {
        await bounded('releaseTurn', () => redis.del(lockKey(runId, turnId)));
      } catch (err) {
        warn('releaseTurn', err);
      }
    },

    async loadRun(runId) {
      try {
        return await bounded('loadRun', () => redis.get<unknown>(runKey(runId)));
      } catch (err) {
        warn('loadRun', err);
        return null;
      }
    },

    async saveRun(runId, run) {
      try {
        // Last write wins. The evaluator drives one turn at a time per run, so
        // concurrent writers are retries of the same turn converging on the
        // same state rather than two different conversations racing.
        await bounded('saveRun', () =>
          redis.set(runKey(runId), run, { px: RUN_TTL_MS }),
        );
      } catch (err) {
        warn('saveRun', err);
      }
    },
  };
}

let cached: SharedStore | null | undefined;

/**
 * The shared store, or null when no Redis is configured — local dev and tests
 * run happily on in-memory state alone. Accepts both the Vercel marketplace
 * names (KV_REST_API_*) and Upstash's own (UPSTASH_REDIS_REST_*).
 */
export function sharedStoreFromEnv(): SharedStore | null {
  if (cached !== undefined) return cached;

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  cached =
    url && token
      ? createSharedStore(
          new Redis({
            url,
            token,
            // One quick retry, not the default five with exponential backoff,
            // which is upwards of ten seconds of sleeping inside a
            // twenty-second turn. The per-call timeout already stops us
            // *waiting* on that; what it cannot stop is the abandoned call
            // carrying on retrying, on an instance that is trying to finish a
            // response. A turn that proceeds without the shared store works.
            retry: { retries: 1, backoff: () => 100 },
          }),
        )
      : null;
  return cached;
}
