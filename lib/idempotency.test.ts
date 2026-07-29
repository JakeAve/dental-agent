import { describe, expect, it } from 'vitest';
import { createSharedStore, type RedisLike } from './idempotency';
import type { Turn } from './run-store';

/**
 * The protocol requires (run_id, turn_id) idempotency, but Vercel runs many
 * instances and the in-memory maps in run-store are per-instance. This store
 * is the cross-instance layer: one claim wins, everyone else waits for and
 * replays the winner's saved turn.
 *
 * The line these tests pin: exactly one claimant executes a turn, a saved turn
 * replays verbatim, and a Redis outage degrades to per-instance behaviour
 * rather than failing the run.
 */

function fakeRedis(): RedisLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get(key) {
      return (store.get(key) ?? null) as never;
    },
    async set(key, value, opts) {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

function brokenRedis(): RedisLike {
  const boom = async () => {
    throw new Error('redis unreachable');
  };
  return { get: boom, set: boom, del: boom };
}

const TURN: Turn = { message: 'Are you a new or returning patient?', status: 'continue' };

describe('claimTurn', () => {
  it('grants the first claim and refuses the second', async () => {
    const store = createSharedStore(fakeRedis());
    expect(await store.claimTurn('r1', 't1')).toBe(true);
    expect(await store.claimTurn('r1', 't1')).toBe(false);
  });

  it('scopes claims to the (run, turn) pair', async () => {
    const store = createSharedStore(fakeRedis());
    expect(await store.claimTurn('r1', 't1')).toBe(true);
    expect(await store.claimTurn('r1', 't2')).toBe(true);
    expect(await store.claimTurn('r2', 't1')).toBe(true);
  });

  it('allows a fresh claim after release', async () => {
    const store = createSharedStore(fakeRedis());
    await store.claimTurn('r1', 't1');
    await store.releaseTurn('r1', 't1');
    expect(await store.claimTurn('r1', 't1')).toBe(true);
  });
});

describe('saveTurn / getTurn', () => {
  it('round-trips a finished turn', async () => {
    const store = createSharedStore(fakeRedis());
    await store.saveTurn('r1', 't1', TURN);
    expect(await store.getTurn('r1', 't1')).toEqual(TURN);
  });

  it('misses for a turn never saved', async () => {
    const store = createSharedStore(fakeRedis());
    expect(await store.getTurn('r1', 'never')).toBeNull();
  });
});

describe('awaitTurn', () => {
  it('resolves once the winner saves the turn', async () => {
    const redis = fakeRedis();
    const store = createSharedStore(redis, { pollIntervalMs: 5, waitDeadlineMs: 500 });
    const waiting = store.awaitTurn('r1', 't1');
    setTimeout(() => void store.saveTurn('r1', 't1', TURN), 25);
    expect(await waiting).toEqual(TURN);
  });

  it('gives up at the deadline when no turn appears', async () => {
    const store = createSharedStore(fakeRedis(), { pollIntervalMs: 5, waitDeadlineMs: 40 });
    expect(await store.awaitTurn('r1', 't1')).toBeNull();
  });
});

describe('saveRun / loadRun', () => {
  const RUN = {
    session: { slotRefs: [] as never[], booked: [] as never[], resolved: false },
    messages: [{ role: 'user' as const, content: 'I need a cleaning.' }],
    seq: 1,
  };

  it('round-trips a run for the instance that takes the next turn', async () => {
    const store = createSharedStore(fakeRedis());
    await store.saveRun('r1', RUN);
    expect(await store.loadRun('r1')).toEqual(RUN);
  });

  it('misses for a run never saved', async () => {
    const store = createSharedStore(fakeRedis());
    expect(await store.loadRun('never')).toBeNull();
  });

  it('keeps runs and turns in separate keys', async () => {
    const redis = fakeRedis();
    const store = createSharedStore(redis);
    await store.saveRun('r1', RUN);
    await store.saveTurn('r1', 't1', TURN);

    expect(await store.loadRun('r1')).toEqual(RUN);
    expect(await store.getTurn('r1', 't1')).toEqual(TURN);
  });
});

describe('redis outage', () => {
  it('fails open so the turn still runs', async () => {
    const store = createSharedStore(brokenRedis(), { pollIntervalMs: 5, waitDeadlineMs: 40 });
    // A miss, a granted claim and a null wait all let the caller proceed
    // exactly as if no shared store were configured.
    expect(await store.getTurn('r1', 't1')).toBeNull();
    expect(await store.claimTurn('r1', 't1')).toBe(true);
    expect(await store.awaitTurn('r1', 't1')).toBeNull();
    await expect(store.saveTurn('r1', 't1', TURN)).resolves.toBeUndefined();
    await expect(store.releaseTurn('r1', 't1')).resolves.toBeUndefined();
  });

  it('degrades a run load to a cold start rather than failing the turn', async () => {
    const store = createSharedStore(brokenRedis());
    expect(await store.loadRun('r1')).toBeNull();
    await expect(
      store.saveRun('r1', {
        session: { slotRefs: [], booked: [], resolved: false },
        messages: [],
        seq: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
