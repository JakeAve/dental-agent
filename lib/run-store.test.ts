import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRuns,
  deserializeRun,
  getRun,
  peekRun,
  publishedRun,
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
    run.messages.push({ role: 'assistant', content: 'Verifying your insurance.' });

    const kept = getRun('r1', HISTORY, {
      seq: 1,
      rev: 1,
      session: stored({ id: 'older', name: 'X', status: 'new' }),
      messages: [{ role: 'user', content: 'I need a cleaning.' }],
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
      seq: 4,
      rev: 3,
      session: stored({ id: 'p1', name: 'Dana Reed', status: 'returning' }, true),
      messages: [
        ...HISTORY.map((h) => ({
          role: h.role === 'patient' ? 'user' : 'assistant',
          content: h.content,
        })),
        { role: 'user', content: 'yes, book the 3pm' },
        { role: 'assistant', content: 'Booked — Thursday at 3pm with Dr Chen.' },
      ],
    });

    expect(adopted.session.booked).toHaveLength(1);
    expect(adopted.rev).toBe(3);
    // Adopted in place: the turn maps are this process's own idempotency
    // record and must not be thrown away with the state.
    expect(adopted.turns.get('t1')?.status).toBe('complete');
  });

  it('claims no revision from a stored copy it cannot read', () => {
    const run = getRun('r1', HISTORY, { seq: 7, rev: 7, session: 'corrupt', messages: [] });

    expect(run.session.patient).toBeUndefined();
    expect(run.rev).toBe(0);
  });

  /**
   * The revision counter can lag the content it belongs to — a write whose
   * confirmation timed out yet landed leaves this instance newer than its own
   * published revision. Ordering on that counter alone would hand it back its
   * own earlier copy and forget the booking it had just made, which is why the
   * message count leads: it is the content rather than a claim about it.
   */
  it('refuses a copy with a higher revision but less conversation', () => {
    const run = getRun('r1', HISTORY);
    run.session.patient = { id: 'p1', name: 'Dana Reed', status: 'returning' };
    run.messages.push({ role: 'assistant', content: 'Booked.' });

    const kept = getRun('r1', HISTORY, {
      seq: 1,
      rev: 99,
      session: stored({ id: 'p1', name: 'Dana Reed', status: 'returning' }),
      messages: [{ role: 'user', content: 'I need a cleaning.' }],
    });

    expect(kept.messages).toHaveLength(3);
  });

  /**
   * `booked` is the one list that shrinks: cancelling filters it. An ordering
   * that treated a shorter list as proof of staleness would refuse the very
   * instance that did the cancelling, leave this one calling a dead appointment
   * live, and — because its own writes would then be refused too — never
   * reconcile for the rest of the run.
   */
  it('adopts a cancellation, which leaves fewer bookings than before', () => {
    const run = getRun('r1', HISTORY);
    run.session.booked = [
      {
        id: 'a1',
        service: 'Cleaning',
        startsAtUtc: '2026-08-03T15:00:00Z',
        provider: 'Dr Chen',
        price: 'Self-pay. Patient owes $125.00.',
      },
    ];

    const adopted = getRun('r1', HISTORY, {
      seq: 5,
      rev: 5,
      session: stored({ id: 'p1', name: 'Dana Reed', status: 'returning' }),
      messages: [
        { role: 'user', content: 'I need a cleaning.' },
        { role: 'assistant', content: 'Are you a new or returning patient?' },
        { role: 'user', content: 'actually cancel it' },
        { role: 'assistant', content: 'Cancelled.' },
        { role: 'user', content: 'thanks' },
      ],
    });

    expect(adopted.session.booked).toHaveLength(0);
  });

  /**
   * A run rebuilt from visible history knows no patient, and no count can
   * express what that costs: booking against it registers the same person
   * twice. A long history could otherwise outnumber a short stored run.
   */
  it('takes a stored copy that knows the patient over one that does not', () => {
    const long = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? ('agent' as const) : ('patient' as const),
      content: `line ${i}`,
    }));
    getRun('r1', long);

    const adopted = getRun('r1', long, {
      seq: 2,
      rev: 1,
      session: stored({ id: 'p1', name: 'Dana Reed', status: 'returning' }),
      messages: [{ role: 'user', content: 'I need a cleaning.' }],
    });

    expect(adopted.session.patient?.id).toBe('p1');
  });

  it('advances its revision only once a publish has landed', () => {
    const run = getRun('r1', HISTORY);
    const published = serializeRun(run);

    // Serializing is not publishing. Claiming a revision that was refused would
    // make this instance outrank the copy that beat it, and it would then
    // decline to adopt that copy — a permanent split rather than a one-turn one.
    expect(run.rev).toBe(0);
    expect(published.rev).toBe(1);
    expect(published.seq).toBe(run.messages.length);

    publishedRun(run, published);
    expect(run.rev).toBe(1);
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

/**
 * The patient id is the one fact that cannot be re-derived: there is no endpoint
 * that finds a patient, so an agent that cannot see its own registration
 * registers the person again, in a system the evaluator reads directly. A run
 * rebuilt from visible history has no patient and can still out-count the copy
 * that has one — three tool calls answering a question about prices will do it —
 * so the count must not be allowed to decide this.
 */
describe('adoption and the patient id', () => {
  const withPatient = (messages: number) => ({
    seq: messages,
    rev: 1,
    session: stored({ id: 'p-real', name: 'Dana Reed', status: 'returning' }),
    messages: Array.from({ length: messages }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    })),
  });

  const withoutPatient = (messages: number) => ({
    seq: messages,
    rev: 9,
    session: { slotRefs: [], booked: [], resolved: false },
    messages: Array.from({ length: messages }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    })),
  });

  it('adopts a copy that knows the patient, however few messages it has', () => {
    getRun('r1', Array.from({ length: 20 }, () => HISTORY[0]));

    expect(getRun('r1', HISTORY, withPatient(2)).session.patient?.id).toBe('p-real');
  });

  it('refuses a copy that does not, however many messages it has', () => {
    const run = getRun('r1', HISTORY);
    run.session.patient = { id: 'p-real', name: 'Dana Reed', status: 'returning' };

    expect(getRun('r1', HISTORY, withoutPatient(50)).session.patient?.id).toBe('p-real');
  });
});
