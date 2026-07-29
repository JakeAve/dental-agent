import { describe, expect, it } from 'vitest';
import type { CedarRidgeClient } from '../cedar-ridge';
import { createSession, type Session } from '../session';
import { appointmentTools } from './appointments';

/**
 * Unit coverage for the paging behaviour of findAvailability.
 *
 * The sandbox returns ten slots a page and, for a fourteen-day window, eleven
 * pages — so page one covers barely a day and a half. These tests pin the two
 * things that made the earlier single-page version lose real openings: that a
 * later page can be fetched at all, and that refs from earlier pages of the same
 * search stay holdable once it has been.
 */

const slot = (n: number, startsAt: string) => ({
  slot_id: `slot-${n}`,
  starts_at: startsAt,
  duration_minutes: 60,
  provider: { id: 'p1', name: 'Tom Becker RDH', type: 'hygienist' },
});

/** Ten slots a page, chronological, one page an hour — like the real API. */
function fakeApi(totalPages: number) {
  const calls: Array<{ service: string; from?: string; to?: string; page?: number }> = [];

  const api = {
    getAvailability: async (params: {
      service: string;
      patient_id: string;
      from?: string;
      to?: string;
      page?: number;
    }) => {
      calls.push({
        service: params.service,
        from: params.from,
        to: params.to,
        page: params.page,
      });

      const page = params.page ?? 1;

      if (page > totalPages) {
        return { availability: [], page, total_pages: totalPages };
      }

      return {
        availability: Array.from({ length: 10 }, (_, i) =>
          slot(
            (page - 1) * 10 + i,
            `2026-08-0${page}T${String(15 + (i % 5)).padStart(2, '0')}:00:00Z`,
          ),
        ),
        page,
        total_pages: totalPages,
      };
    },
  } as unknown as CedarRidgeClient;

  return { api, calls };
}

/** A session past the gates findAvailability checks before it calls the API. */
function readySession(): Session {
  const session = createSession();
  session.patient = { id: 'patient-1', name: 'Ada Probe', status: 'returning' };
  session.insurance = { status: 'self_pay' };
  return session;
}

const search = (
  api: CedarRidgeClient,
  session: Session,
  input: { service: string; from?: string; to?: string; page?: number },
) =>
  // The tool's execute signature carries the SDK's ToolCallOptions argument,
  // which this tool never reads — so it is dropped rather than faked.
  (
    appointmentTools(api, session).findAvailability.execute as unknown as (
      input: unknown,
    ) => Promise<Record<string, unknown>>
  )(input);

describe('findAvailability paging', () => {
  it('passes the requested page through to the API', async () => {
    const { api, calls } = fakeApi(11);
    const session = readySession();

    await search(api, session, { service: 'D1110', page: 3 });

    expect(calls).toEqual([
      { service: 'D1110', from: undefined, to: undefined, page: 3 },
    ]);
  });

  it('reports the page it is on and how many there are', async () => {
    const { api } = fakeApi(11);
    const session = readySession();

    const result = await search(api, session, { service: 'D1110' });

    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(11);
  });

  it('keeps refs from earlier pages of the same search holdable', async () => {
    const { api } = fakeApi(11);
    const session = readySession();

    const first = await search(api, session, { service: 'D1110' });
    const firstRefs = (first.slots as Array<{ ref: string }>).map((s) => s.ref);

    const second = await search(api, session, { service: 'D1110', page: 2 });
    const secondRefs = (second.slots as Array<{ ref: string }>).map((s) => s.ref);

    // Page two's refs continue the numbering rather than colliding with page one.
    expect(secondRefs).not.toEqual(firstRefs);
    expect(new Set([...firstRefs, ...secondRefs]).size).toBe(20);

    // And page one's slots can still be held after paging forward — the patient
    // may well pick from the times they were offered first.
    for (const ref of firstRefs) {
      expect(session.slotRefs.get(ref)?.slotId).toBeDefined();
    }
    expect(session.slotRefs.get(firstRefs[0])?.slotId).toBe('slot-0');
    expect(session.slotRefs.get(secondRefs[0])?.slotId).toBe('slot-10');
  });

  it('reuses the ref for a slot it has already seen', async () => {
    const { api } = fakeApi(11);
    const session = readySession();

    // Re-running the same search — a retry, or a second look at page one after
    // paging on — must not list the same time twice under two refs.
    const first = await search(api, session, { service: 'D1110' });
    await search(api, session, { service: 'D1110', page: 2 });
    const again = await search(api, session, { service: 'D1110' });

    expect((again.slots as Array<{ ref: string }>).map((s) => s.ref)).toEqual(
      (first.slots as Array<{ ref: string }>).map((s) => s.ref),
    );
    expect(session.slotRefs.size).toBe(20);
  });

  it('drops stale refs when the search itself changes', async () => {
    const { api } = fakeApi(11);
    const session = readySession();

    const first = await search(api, session, { service: 'D1110' });
    const firstRefs = (first.slots as Array<{ ref: string }>).map((s) => s.ref);

    // A different window is a different set of options: the old refs point at
    // times the patient is no longer being offered.
    const second = await search(api, session, {
      service: 'D1110',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    const secondRefs = (second.slots as Array<{ ref: string }>).map((s) => s.ref);

    expect(secondRefs).toEqual(firstRefs);
    expect(session.slotRefs.size).toBe(10);
    expect(session.slotRefs.get(firstRefs[0])?.slotId).toBe('slot-0');
  });

  it('tells the agent to page on rather than to widen, when pages remain', async () => {
    const { api } = fakeApi(11);
    const session = readySession();

    const result = await search(api, session, { service: 'D1110' });

    expect(result.guidance).toMatch(/page/i);
  });

  it('does not suggest widening a window that simply ran out of pages', async () => {
    const { api } = fakeApi(4);
    const session = readySession();

    const result = await search(api, session, { service: 'D1110', page: 5 });

    expect(result.slots).toEqual([]);
    // The window is not the problem — page five of four is.
    expect(result.guidance).not.toMatch(/30 to 60 days/);
    expect(result.guidance).toMatch(/page/i);
  });

  it('still suggests widening when the window itself is empty', async () => {
    const { api } = fakeApi(0);
    const session = readySession();

    const result = await search(api, session, { service: 'D1110' });

    expect(result.slots).toEqual([]);
    expect(result.guidance).toMatch(/30 to 60 days/);
  });

  it('leaves earlier refs alone when a later page comes back empty', async () => {
    const { api } = fakeApi(1);
    const session = readySession();

    const first = await search(api, session, { service: 'D1110' });
    const firstRefs = (first.slots as Array<{ ref: string }>).map((s) => s.ref);

    await search(api, session, { service: 'D1110', page: 2 });

    // Running off the end must not strand the times already on offer.
    expect(session.slotRefs.get(firstRefs[0])?.slotId).toBe('slot-0');
    expect(session.slotRefs.size).toBe(10);
  });
});
