import { describe, expect, it } from 'vitest';
import { CedarRidgeError, type CedarRidgeClient } from '../cedar-ridge';
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

/**
 * The duplicate booking the protocol names outright, and the narrowest way in.
 *
 * `POST /appointments` is not cancelled at the far end when the turn's deadline
 * fires, so the appointment can exist while nothing here records it — its id
 * lives only in a response nobody read, and there is no endpoint that lists a
 * patient's appointments. The only recovery is the API's own idempotency:
 * confirming the same hold again returns the appointment already created for it.
 */

/** An API that hangs on confirm, exactly as a killed turn experiences it. */
function stalledConfirm() {
  const api = {
    holdSlot: async () => ({ hold_id: 'hold-2', expires_in_seconds: 300 }),
    confirmAppointment: () => new Promise<never>(() => {}),
  } as unknown as CedarRidgeClient;

  return api;
}

/** An API that answers the second confirm with the appointment it already made. */
function idempotentConfirm() {
  const confirms: string[] = [];

  const api = {
    confirmAppointment: async ({ hold_id }: { hold_id: string }) => {
      confirms.push(hold_id);
      return {
        id: 'appt-1',
        service_name: 'Adult Cleaning',
        starts_at: '2026-08-03T15:00:00Z',
        duration_minutes: 60,
        provider: { id: 'p1', name: 'Tom Becker RDH', type: 'hygienist' },
        status: 'confirmed',
        self_pay_price: 12500,
      };
    },
  } as unknown as CedarRidgeClient;

  return { api, confirms };
}

const held = (session: Session) => {
  session.hold = {
    holdId: 'hold-1',
    slotId: 'slot-1',
    service: 'D1110',
    startsAtUtc: '2026-08-03T15:00:00Z',
    expiresAtMs: Date.now() + 300_000,
  };
  return session;
};

const call = (
  api: CedarRidgeClient,
  session: Session,
  name: 'holdSlot' | 'confirmAppointment',
  input: unknown = {},
) =>
  (
    appointmentTools(api, session)[name].execute as unknown as (
      input: unknown,
    ) => Promise<Record<string, unknown>>
  )(input);

describe('a confirmation that was never answered', () => {
  it('is recorded before the request, not after it', async () => {
    const session = held(readySession());

    // Started and abandoned, as the turn deadline does.
    void call(stalledConfirm(), session, 'confirmAppointment');
    await Promise.resolve();

    expect(session.pendingConfirm?.holdId).toBe('hold-1');
    expect(session.booked).toHaveLength(0);
  });

  it('blocks a fresh hold, which is the first step of booking twice', async () => {
    const session = readySession();
    session.pendingConfirm = {
      holdId: 'hold-1',
      service: 'D1110',
      startsAtUtc: '2026-08-03T15:00:00Z',
    };
    session.slotRefs.set('1', { slotId: 'slot-9', startsAtUtc: '2026-08-04T15:00:00Z' });

    const result = await call(stalledConfirm(), session, 'holdSlot', {
      ref: '1',
      service: 'D1110',
    });

    expect(result.ok).toBe(false);
    expect(String(result.guidance)).toMatch(/confirmAppointment first/);
  });

  it('re-sends the same hold and takes the appointment the API returns', async () => {
    const { api, confirms } = idempotentConfirm();
    const session = readySession();
    // The hold is gone — only the unanswered confirmation is left, which is
    // exactly the state a killed turn leaves on another instance.
    session.pendingConfirm = {
      holdId: 'hold-1',
      service: 'D1110',
      startsAtUtc: '2026-08-03T15:00:00Z',
    };

    const result = await call(api, session, 'confirmAppointment');

    expect(confirms).toEqual(['hold-1']);
    expect(result.status).toBe('confirmed');
    expect(session.booked).toHaveLength(1);
    expect(session.pendingConfirm).toBeUndefined();
  });

  it('does not book twice when the same appointment comes back again', async () => {
    const { api } = idempotentConfirm();
    const session = held(readySession());

    await call(api, session, 'confirmAppointment');
    session.hold = {
      holdId: 'hold-1',
      slotId: 'slot-1',
      service: 'D1110',
      startsAtUtc: '2026-08-03T15:00:00Z',
      expiresAtMs: Date.now() + 300_000,
    };
    await call(api, session, 'confirmAppointment');

    expect(session.booked).toHaveLength(1);
  });

  it('stands down once the API has answered, even with an error', async () => {
    const session = held(readySession());
    const api = {
      confirmAppointment: async () => {
        throw new CedarRidgeError('HOLD_ALREADY_USED', 'superseded', 409, {});
      },
    } as unknown as CedarRidgeClient;

    const result = await call(api, session, 'confirmAppointment');

    // A 409 is the API telling us where it stands. Only silence is ambiguous,
    // and treating an answered error as ambiguous would lock the conversation
    // out of booking the slot the patient actually chose.
    expect(result.ok).toBe(false);
    expect(session.pendingConfirm).toBeUndefined();
  });
});
