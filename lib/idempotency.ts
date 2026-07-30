import { Redis } from '@upstash/redis';
import {
  LOCK_TTL_MS,
  REDIS_OP_TIMEOUT_MS,
  RUN_TTL_MS,
  TURN_WAIT_DEADLINE_MS,
  TURN_WAIT_POLL_MS,
} from './config';
import { errorLabel } from './log';
import { parseTurn, type PersistedRun, type Turn } from './run-store';

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
  eval<T>(script: string, keys: string[], args: unknown[]): Promise<T>;
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
  /**
   * Publish the run's state for whichever instance takes the next turn, unless
   * the stored copy is already at or past this version.
   *
   * True only when the write landed, which is what lets the caller advance its
   * own version in step with the store rather than ahead of it.
   */
  saveRun(runId: string, run: PersistedRun): Promise<boolean>;
};

const turnKey = (runId: string, turnId: string) => `dental-agent:turn:${runId}:${turnId}`;
const lockKey = (runId: string, turnId: string) => `dental-agent:lock:${runId}:${turnId}`;
const runKey = (runId: string) => `dental-agent:run:${runId}`;

/**
 * Write the run only if it is ahead of the stored copy. Returns 1 or 0.
 *
 * Ordered on the message count first and the revision second, the same pair
 * run-store compares — the count because it is the content itself, the revision
 * for a publish that changed the session without adding a message.
 *
 * Server-side because the check and the write have to be one step. Reading the
 * version in the route and writing it here leaves a gap wide enough for the
 * failure this exists to stop: an instance whose read of the stored run failed
 * open sees no version at all, and would otherwise publish its own thinner
 * state — no patient id, no hold, no booking — over three turns of real work.
 *
 * An unreadable stored value is treated as absent and overwritten: it is of no
 * use to anyone, and refusing to write would leave the run with no shared state
 * for as long as it stood.
 */
const CAS_RUN = `
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, current = pcall(cjson.decode, raw)
  if ok and type(current) == 'table' then
    -- The patient id outranks the ordering, in this direction as well as in
    -- the one run-store guards. A run rebuilt from visible history knows no
    -- patient and can still out-count the copy that registered one, and a
    -- write that drops it costs a duplicate patient record.
    local mine = cjson.decode(ARGV[1])
    if current.session and current.session.patient
       and not (mine.session and mine.session.patient) then
      return 0
    end

    local seq = tonumber(current.seq)
    local rev = tonumber(current.rev) or 0
    if seq ~= nil then
      if seq > tonumber(ARGV[2]) then return 0 end
      if seq == tonumber(ARGV[2]) and rev >= tonumber(ARGV[3]) then return 0 end
    end
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[4]))
return 1
`;

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
  // Class only. A Redis client is entitled to quote the command it was running,
  // and the commands here carry a whole conversation. See lib/log.ts.
  console.warn(`[idempotency] ${op} failed open: ${errorLabel(err)}`);
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
  const bounded = <T>(op: string, work: () => Promise<T>, ms = opTimeoutMs) =>
    withTimeout(work(), ms, op);

  const getTurn = async (runId: string, turnId: string) => {
    try {
      // Validated, not cast: this value is replayed to the evaluator without
      // passing through any of the code that produced the original.
      return parseTurn(await bounded('getTurn', () => redis.get(turnKey(runId, turnId))));
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
        // Given longer than the rest, because this is the one call whose
        // fail-open direction is dangerous: cut short, it grants a claim that
        // may already belong to someone else, and on a booking turn that is a
        // second booking. A read failing open merely costs state.
        const won = await bounded(
          'claimTurn',
          () => redis.set(lockKey(runId, turnId), '1', { nx: true, px: LOCK_TTL_MS }),
          opTimeoutMs * 2,
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
        // Checked before sleeping as well as before polling: a poll that starts
        // just inside the deadline would otherwise overshoot it by the interval.
        if (Date.now() + pollIntervalMs >= deadline) break;
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
      const body = JSON.stringify(run);

      try {
        const written = await bounded('saveRun', () =>
          redis.eval<number>(CAS_RUN, [runKey(runId)], [
            body,
            run.seq,
            run.rev,
            RUN_TTL_MS,
          ]),
        );

        if (written !== 1) {
          // Not an error: another instance is further along than we are. Its
          // copy stands, and ours is the one that was behind.
          console.warn(
            '[idempotency] saveRun skipped: stored run is at or past ' +
              `seq ${run.seq} rev ${run.rev}`,
          );
        }

        return written === 1;
      } catch (err) {
        // No plain-SET fallback here, on purpose. The reason this call fails is
        // almost always the per-op timeout, and that is the same condition that
        // makes an instance stale: its own `loadRun` failed open moments ago, so
        // it has no idea what the stored copy holds. An unconditional write then
        // lands exactly the state the script exists to refuse. Declining costs
        // nothing when the stored copy is fresher, which is the case that
        // matters; EVAL support itself is not in question, and is checked
        // against the real Redis in e2e/shared-store.spec.ts.
        warn('saveRun', err);
        return false;
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
            // which is around four seconds of sleeping inside a twenty-second
            // turn. The per-call timeout already stops us
            // *waiting* on that; what it cannot stop is the abandoned call
            // carrying on retrying, on an instance that is trying to finish a
            // response. A turn that proceeds without the shared store works.
            retry: { retries: 1, backoff: () => 100 },
          }),
        )
      : null;
  return cached;
}
