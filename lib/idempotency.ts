import { Redis } from '@upstash/redis';
import { LOCK_TTL_MS, RUN_TTL_MS, TURN_WAIT_DEADLINE_MS, TURN_WAIT_POLL_MS } from './config';
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
  /** Poll for the claim winner's result; null once the deadline passes. */
  awaitTurn(runId: string, turnId: string): Promise<Turn | null>;
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

function warn(op: string, err: unknown) {
  // Message only — never key material, and Redis errors can echo commands.
  console.warn(
    `[idempotency] ${op} failed open: ${err instanceof Error ? err.message : 'unknown error'}`,
  );
}

export function createSharedStore(
  redis: RedisLike,
  opts: { pollIntervalMs?: number; waitDeadlineMs?: number } = {},
): SharedStore {
  const pollIntervalMs = opts.pollIntervalMs ?? TURN_WAIT_POLL_MS;
  const waitDeadlineMs = opts.waitDeadlineMs ?? TURN_WAIT_DEADLINE_MS;

  const getTurn = async (runId: string, turnId: string) => {
    try {
      return await redis.get<Turn>(turnKey(runId, turnId));
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
        const won = await redis.set(lockKey(runId, turnId), '1', {
          nx: true,
          px: LOCK_TTL_MS,
        });
        return won !== null;
      } catch (err) {
        warn('claimTurn', err);
        return true;
      }
    },

    async saveTurn(runId, turnId, turn) {
      try {
        await redis.set(turnKey(runId, turnId), turn, { px: RUN_TTL_MS });
      } catch (err) {
        warn('saveTurn', err);
      }
    },

    async awaitTurn(runId, turnId) {
      const deadline = Date.now() + waitDeadlineMs;
      while (Date.now() < deadline) {
        const turn = await getTurn(runId, turnId);
        if (turn) return turn;
        await sleep(pollIntervalMs);
      }
      return null;
    },

    async releaseTurn(runId, turnId) {
      try {
        await redis.del(lockKey(runId, turnId));
      } catch (err) {
        warn('releaseTurn', err);
      }
    },

    async loadRun(runId) {
      try {
        return await redis.get<unknown>(runKey(runId));
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
        await redis.set(runKey(runId), run, { px: RUN_TTL_MS });
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

  cached = url && token ? createSharedStore(new Redis({ url, token })) : null;
  return cached;
}
