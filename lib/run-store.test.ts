import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRuns,
  deserializeRun,
  getRun,
  peekRun,
  serializeRun,
} from './run-store';

/**
 * The protocol allows either keeping run state by `run_id` or rebuilding it
 * from `input.history`, and the difference matters: history is only the visible
 * turns, so a run rebuilt from it has forgotten the patient id, the slots it
 * offered and any live hold. On Vercel a later turn can land on an instance
 * that never saw the earlier ones, so "keep it" has to mean the shared store.
 *
 * These tests pin the round trip and, more importantly, what happens when it
 * cannot be trusted: a rejected value must fall back to history rather than
 * hand the tools a half-populated session.
 */

/** A stored session, as the shared store would hold it. */
const stored = (
  patient: { id: string; name: string; status: 'new' | 'returning' },
  booked = false,
) => ({
  patient,
  slotRefs: [],
  booked: booked
    ? [
        {
          id: 'a1',
          service: 'Cleaning',
          startsAtUtc: '2026-08-03T15:00:00Z',
          provider: 'Dr Chen',
          price: 'Self-pay. Patient owes $125.00.',
        },
      ]
    : [],
  resolved: booked,
});

const HISTORY = [
  { role: 'patient' as const, content: 'I need a cleaning.' },
  { role: 'agent' as const, content: 'Are you a new or returning patient?' },
];

beforeEach(clearRuns);

describe('getRun', () => {
  it('rebuilds from history when there is nothing else', () => {
    const run = getRun('r1', HISTORY);

    expect(run.messages).toEqual([
      { role: 'user', content: 'I need a cleaning.' },
      { role: 'assistant', content: 'Are you a new or returning patient?' },
    ]);
    expect(run.session.patient).toBeUndefined();
  });

  it('returns the same run object on the next turn', () => {
    const first = getRun('r1', HISTORY);
    first.session.patient = { id: 'p1', name: 'Dana Reed', status: 'returning' };

    expect(getRun('r1', HISTORY).session.patient?.id).toBe('p1');
  });

  it('prefers restored state over history', () => {
    const source = getRun('r1', HISTORY);
    source.session.patient = { id: 'p1', name: 'Dana Reed', status: 'returning' };
    source.session.slotRefs.set('1', { slotId: 'slot-abc', startsAtUtc: '2026-08-03T15:00:00Z' });
    source.messages.push({ role: 'assistant', content: 'Verifying your insurance now.' });

    const persisted = JSON.parse(JSON.stringify(serializeRun(source)));
    clearRuns();

    const restored = getRun('r1', HISTORY, persisted);

    expect(restored.session.patient?.id).toBe('p1');
    expect(restored.session.slotRefs.get('1')?.slotId).toBe('slot-abc');
    expect(restored.messages).toHaveLength(3);
  });

  it('falls back to history when the stored run is malformed', () => {
    // A shape change between deployments looks exactly like this.
    const run = getRun('r1', HISTORY, { session: { booked: 'not an array' }, messages: [] });

    expect(run.messages).toHaveLength(2);
    expect(run.session.patient).toBeUndefined();
  });

  it('keeps its own state when the stored copy is no further along', () => {
    const run = getRun('r1', HISTORY);
    run.session.patient = { id: 'live', name: 'Dana Reed', status: 'returning' };
    // This process has absorbed a turn the stored copy has not.
    run.seq = 2;

    const kept = getRun('r1', HISTORY, {
      seq: 1,
      session: stored({ id: 'older', name: 'X', status: 'new' }),
      messages: [],
    });

    expect(kept.session.patient?.id).toBe('live');
  });

  /**
   * The case that made versioning necessary: instances stay warm, so the
   * instance that served turn 1 can be handed turn 4 while turns 2 and 3 ran
   * somewhere else. Preferring what it happens to hold means answering without
   * the hold or the booking — and then publishing that over the real state.
   */
  it('adopts the stored copy when another instance has gone further', () => {
    const run = getRun('r1', HISTORY);
    run.session.patient = { id: 'p1', name: 'Dana Reed', status: 'returning' };
    run.turns.set('t1', { message: 'Booked.', status: 'complete' });

    const adopted = getRun('r1', HISTORY, {
      seq: 3,
      session: stored({ id: 'p1', name: 'Dana Reed', status: 'returning' }, true),
      messages: [{ role: 'user', content: 'yes, book the 3pm' }],
    });

    expect(adopted.session.booked).toHaveLength(1);
    expect(adopted.seq).toBe(3);
    // Adopted in place: the turn maps are this process's own idempotency
    // record and must not be thrown away with the state.
    expect(adopted.turns.get('t1')?.status).toBe('complete');
  });

  it('sorts its next publish after a stored copy it cannot read', () => {
    const run = getRun('r1', HISTORY, { seq: 7, session: 'corrupt', messages: [] });

    expect(run.session.patient).toBeUndefined();
    expect(serializeRun(run).seq).toBeGreaterThan(7);
  });
});

describe('peekRun', () => {
  it('does not create a run', () => {
    expect(peekRun('never')).toBeUndefined();
    expect(peekRun('never')).toBeUndefined();
  });

  it('finds one this process already has', () => {
    getRun('r1', HISTORY);
    expect(peekRun('r1')).toBeDefined();
  });
});

describe('serializeRun', () => {
  it('survives JSON, including the slotRefs Map and a live hold', () => {
    const run = getRun('r1', []);
    run.session.patient = { id: 'p1', name: 'Dana Reed', status: 'new' };
    run.session.insurance = { status: 'active', planName: 'Aetna', coveredCodes: ['D1110'] };
    run.session.slotRefs.set('1', { slotId: 'slot-abc', startsAtUtc: '2026-08-03T15:00:00Z' });
    run.session.slotSearch = 'D1110||';
    run.session.hold = {
      holdId: 'h1',
      slotId: 'slot-abc',
      service: 'D1110',
      startsAtUtc: '2026-08-03T15:00:00Z',
      // Absolute epoch ms, so it still means the same thing on another instance.
      expiresAtMs: 1_800_000_000_000,
    };
    run.session.booked = [
      {
        id: 'a1',
        service: 'Cleaning',
        startsAtUtc: '2026-08-03T15:00:00Z',
        provider: 'Dr Chen',
        price: 'Self-pay. Patient owes $125.00.',
      },
    ];
    run.session.resolved = true;

    const wire = JSON.parse(JSON.stringify(serializeRun(run)));
    const back = deserializeRun(wire);

    expect(back?.session).toEqual(run.session);
  });
});

describe('deserializeRun', () => {
  it('rejects a value that is not a run at all', () => {
    expect(deserializeRun(null)).toBeNull();
    expect(deserializeRun('{}')).toBeNull();
    expect(deserializeRun({ messages: [] })).toBeNull();
  });

  it('rejects messages that are not role-bearing objects', () => {
    const session = { slotRefs: [], booked: [], resolved: false };
    expect(deserializeRun({ session, messages: ['hello'] })).toBeNull();
  });

  it('accepts message shapes it does not model, since the SDK owns them', () => {
    const session = { slotRefs: [], booked: [], resolved: false };
    const back = deserializeRun({
      session,
      messages: [
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 'findAvailability', output: { slots: [] } },
          ],
        },
      ],
    });

    expect(back?.messages).toHaveLength(1);
  });
});
