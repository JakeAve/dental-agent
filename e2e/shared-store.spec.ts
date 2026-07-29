import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { describe, expect, it } from 'vitest';
import { sharedStoreFromEnv } from '../lib/idempotency';

/**
 * The compare-and-set behind `saveRun` is a Lua script, and a fake cannot prove
 * a Lua script parses. The unit tests stub `eval` with the semantics the script
 * is supposed to have, which is exactly the kind of test that stays green while
 * the real thing fails on every call — and it fails quietly, because the store
 * is built to degrade rather than throw. A run would simply stop being
 * persisted, and only a cold instance mid-conversation would show it.
 *
 * So this one runs against the configured Redis. It touches no scheduling API,
 * creates no patient and books nothing; it is here rather than in the unit
 * suite only because it needs the network.
 */

const store = sharedStoreFromEnv();

const run = (seq: number, patientId: string, rev = 1) => ({
  seq,
  rev,
  session: {
    patient: { id: patientId, name: 'Dana Reed', status: 'returning' as const },
    slotRefs: [] as Array<[string, { slotId: string; startsAtUtc: string }]>,
    booked: [],
    resolved: false,
  },
  messages: [{ role: 'user' as const, content: 'I need a cleaning.' }],
});

describe.skipIf(!store)('the shared store, against real Redis', () => {
  it('runs the compare-and-set script rather than failing open into a plain write', async () => {
    const runId = `e2e-cas-${randomUUID()}`;

    expect(await store!.saveRun(runId, run(3, 'p-three'))).toBe(true);

    // Behind: refused, and the stored copy is untouched. A `false` here could
    // also mean the script errored and the fallback write was attempted, so the
    // read is what distinguishes a working compare from a broken one.
    expect(await store!.saveRun(runId, run(2, 'p-two'))).toBe(false);

    const afterStale = (await store!.loadRun(runId)) as { seq: number } | null;
    expect(afterStale?.seq).toBe(3);
    expect(JSON.stringify(afterStale)).toContain('p-three');

    // Level: also refused, so two instances at the same version cannot silently
    // trade places.
    expect(await store!.saveRun(runId, run(3, 'p-level'))).toBe(false);
    expect(JSON.stringify(await store!.loadRun(runId))).toContain('p-three');

    // Forward: accepted.
    expect(await store!.saveRun(runId, run(4, 'p-four'))).toBe(true);
    expect(JSON.stringify(await store!.loadRun(runId))).toContain('p-four');
  });

  it('writes over a stored value it cannot decode, which is of use to nobody', async () => {
    const runId = `e2e-cas-${randomUUID()}`;
    const redis = new Redis({
      url: (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)!,
      token: (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN)!,
    });

    // Something that is not a run at all, on the key a run would use.
    await redis.set(`dental-agent:run:${runId}`, 'not a run', { px: 60_000 });

    // The script must neither error on it nor read it as "already ahead of
    // you", which would refuse every write for as long as it stood.
    expect(await store!.saveRun(runId, run(1, 'p-one'))).toBe(true);
    expect(JSON.stringify(await store!.loadRun(runId))).toContain('p-one');
  });

  it('starts a run that has never been written', async () => {
    const runId = `e2e-cas-${randomUUID()}`;

    expect(await store!.loadRun(runId)).toBeNull();
    expect(await store!.saveRun(runId, run(1, 'p-first'))).toBe(true);
  });
});
