import { describe, expect, it } from 'vitest';
import { createTurnStore, type RedisLike } from './idempotency';
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
    const store = createTurnStore(fakeRedis());
    expect(await store.claimTurn('r1', 't1')).toBe(true);
    expect(await store.claimTurn('r1', 't1')).toBe(false);
  });

  it('scopes claims to the (run, turn) pair', async () => {
    const store = createTurnStore(fakeRedis());
    expect(await store.claimTurn('r1', 't1')).toBe(true);
    expect(await store.claimTurn('r1', 't2')).toBe(true);
    expect(await store.claimTurn('r2', 't1')).toBe(true);
  });

  it('allows a fresh claim after release', async () => {
    const store = createTurnStore(fakeRedis());
    await store.claimTurn('r1', 't1');
    await store.releaseTurn('r1', 't1');
    expect(await store.claimTurn('r1', 't1')).toBe(true);
  });
});

describe('saveTurn / getTurn', () => {
  it('round-trips a finished turn', async () => {
    const store = createTurnStore(fakeRedis());
    await store.saveTurn('r1', 't1', TURN);
    expect(await store.getTurn('r1', 't1')).toEqual(TURN);
  });

  it('misses for a turn never saved', async () => {
    const store = createTurnStore(fakeRedis());
    expect(await store.getTurn('r1', 'never')).toBeNull();
  });
});

describe('awaitTurn', () => {
  it('resolves once the winner saves the turn', async () => {
    const redis = fakeRedis();
    const store = createTurnStore(redis, { pollIntervalMs: 5, waitDeadlineMs: 500 });
    const waiting = store.awaitTurn('r1', 't1');
    setTimeout(() => void store.saveTurn('r1', 't1', TURN), 25);
    expect(await waiting).toEqual(TURN);
  });

  it('gives up at the deadline when no turn appears', async () => {
    const store = createTurnStore(fakeRedis(), { pollIntervalMs: 5, waitDeadlineMs: 40 });
    expect(await store.awaitTurn('r1', 't1')).toBeNull();
  });
});

describe('redis outage', () => {
  it('fails open so the turn still runs', async () => {
    const store = createTurnStore(brokenRedis(), { pollIntervalMs: 5, waitDeadlineMs: 40 });
    // A miss, a granted claim and a null wait all let the caller proceed
    // exactly as if no shared store were configured.
    expect(await store.getTurn('r1', 't1')).toBeNull();
    expect(await store.claimTurn('r1', 't1')).toBe(true);
    expect(await store.awaitTurn('r1', 't1')).toBeNull();
    await expect(store.saveTurn('r1', 't1', TURN)).resolves.toBeUndefined();
    await expect(store.releaseTurn('r1', 't1')).resolves.toBeUndefined();
  });
});
