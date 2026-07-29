import { describe, expect, it } from 'vitest';
import { CedarRidgeError, type CedarRidgeClient } from '../cedar-ridge';
import { PRACTICE, WIDENED_SEARCH_DAYS } from '../config';
import { CONFIRM_ATTEMPT_LIMIT, createSession, type Session } from '../session';
import { addDays, isCalendarDate, practiceDate } from '../time';
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

  it('reports a genuinely empty window as empty, having already widened it', async () => {
    const { api, calls } = fakeApi(0);
    const session = readySession();

    const result = await search(api, session, { service: 'D1110' });

    expect(result.slots).toEqual([]);
    // Widened once, automatically, and the guidance must not send the model
    // round again to widen a window that has already been widened.
    expect(calls).toHaveLength(2);
    expect(result.guidance).toMatch(/already widened/i);
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
      attempts: 1,
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
      attempts: 1,
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


/**
 * The old answer to an empty window was a paragraph asking the model to search
 * again over 30 to 60 days. It usually did — and "usually" is the problem,
 * because the cost of forgetting is telling a patient the practice is full when
 * it has openings all month. WIDENED_SEARCH_DAYS existed as a constant and was
 * referenced nowhere.
 */

/** Empty inside the default window, with openings further out. */
function fakeSparseApi(openFrom: string) {
  const calls: Array<{ from?: string; to?: string; page?: number }> = [];

  const api = {
    getAvailability: async (params: { from?: string; to?: string; page?: number }) => {
      calls.push({ from: params.from, to: params.to, page: params.page });

      // An omitted `to` is not an unbounded window: the API defaults to
      // fourteen days, which is the whole reason an empty first search is worth
      // retrying wider. A `to` this fake cannot read gets the same default,
      // rather than sorting its way to a wrong answer.
      const asked = isCalendarDate(params.to) ? params.to : addDays(practiceDate(), 14)!;
      const reaches = asked >= openFrom;

      return {
        availability: reaches ? [slot(1, `${openFrom}T15:00:00Z`)] : [],
        page: params.page ?? 1,
        total_pages: reaches ? 1 : 0,
      };
    },
  } as unknown as CedarRidgeClient;

  return { api, calls };
}

describe('an empty window widens itself', () => {
  const wide = addDays(practiceDate(), WIDENED_SEARCH_DAYS)!;

  it('retries once at the widened window and returns what it finds', async () => {
    const { api, calls } = fakeSparseApi(addDays(practiceDate(), 40)!);
    const session = readySession();

    const result = await search(api, session, { service: 'D1110' });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ from: undefined, to: undefined });
    expect(calls[1]).toMatchObject({ from: practiceDate(), to: wide });
    expect(result.slots).toHaveLength(1);
  });

  it('says the times are not from the window that was asked for', async () => {
    const { api } = fakeSparseApi(addDays(practiceDate(), 40)!);
    const session = readySession();

    const result = await search(api, session, {
      service: 'D1110',
      from: practiceDate(),
      to: addDays(practiceDate(), 3)!,
    });

    // Offering them as though they were what was asked for is the failure this
    // wording exists to prevent.
    expect(result.guidance).toMatch(/widened/i);
    expect(result.searchedTo).toBe(wide);
  });

  it('does not widen a window that is already wider', async () => {
    const { api, calls } = fakeSparseApi(addDays(practiceDate(), 400)!);
    const session = readySession();

    await search(api, session, {
      service: 'D1110',
      from: practiceDate(),
      to: addDays(practiceDate(), 90)!,
    });

    expect(calls).toHaveLength(1);
  });

  it('does not widen when a later page runs out, which is not a window problem', async () => {
    const { api, calls } = fakeApi(4);
    const session = readySession();

    await search(api, session, { service: 'D1110', page: 9 });

    expect(calls).toHaveLength(1);
  });

  /**
   * The next call is almost always "page 2 of that", with the model repeating
   * the arguments it used before — which are the arguments of the window that
   * came back empty. Paging that window instead of the one that produced page 1
   * asks for the second page of a search that had no first page: it returns
   * nothing, clears every ref the patient is choosing from, and reports that
   * "the times you already fetched are still on offer" as it deletes them.
   */
  it('pages the window that produced the times, not the one that was asked for', async () => {
    const { api, calls } = fakeSparseApi(addDays(practiceDate(), 40)!);
    const session = readySession();

    const first = await search(api, session, { service: 'D1110' });
    const refs = (first.slots as Array<{ ref: string }>).map((s) => s.ref);

    const next = await search(api, session, { service: 'D1110', page: 2 });

    expect(calls.at(-1)).toMatchObject({ from: practiceDate(), to: wide, page: 2 });
    expect(next.slots).not.toEqual([]);
    // The refs the patient was offered survive the page turn.
    expect([...session.slotRefs.keys()]).toEqual(expect.arrayContaining(refs));
  });

  it('keeps the refs when the same search is repeated verbatim', async () => {
    const { api } = fakeSparseApi(addDays(practiceDate(), 40)!);
    const session = readySession();

    await search(api, session, { service: 'D1110' });
    const refs = [...session.slotRefs.keys()];

    await search(api, session, { service: 'D1110' });

    expect([...session.slotRefs.keys()]).toEqual(refs);
  });

  it('drops the refs when the patient is sent somewhere genuinely different', async () => {
    const { api } = fakeSparseApi(addDays(practiceDate(), 40)!);
    const session = readySession();

    await search(api, session, { service: 'D1110' });
    await search(api, session, { service: 'D0150' });

    expect(session.slotSearch).toBe('D0150||');
  });

  it('does not read an unpadded date as the wider window', async () => {
    // '2026-8-5' sorts before '2026-09-27', so a comparison that trusts the
    // shape concludes the caller already asked for two months and never widens
    // — in exactly the scarce case widening exists for.
    const { api, calls } = fakeSparseApi(addDays(practiceDate(), 40)!);
    const session = readySession();

    await search(api, session, { service: 'D1110', from: '2026-8-1', to: '2026-8-5' });

    expect(calls).toHaveLength(2);
  });

  it('survives a date it cannot parse at all, rather than throwing', async () => {
    const { api } = fakeSparseApi(addDays(practiceDate(), 40)!);
    const session = readySession();

    const result = await search(api, session, { service: 'D1110', from: 'next Tuesday' });

    // withRecovery rethrows anything that is not a CedarRidgeError, so a
    // RangeError here is not a recoverable tool result — it is a dead turn.
    expect(result).toBeDefined();
  });
});

describe('a confirmation with no definitive answer', () => {
  const failing = (status: number, code: 'UNKNOWN' | 'HOLD_ALREADY_USED') =>
    ({
      confirmAppointment: async () => {
        throw new CedarRidgeError(code, 'upstream', status, {});
      },
    }) as unknown as CedarRidgeClient;

  it('keeps the marker on a 5xx, which is silence with a status code', async () => {
    const session = held(readySession());

    await call(failing(504, 'UNKNOWN'), session, 'confirmAppointment');

    // The write may well have been carried out; we simply do not know, which is
    // the same position a turn killed mid-request leaves us in.
    expect(session.pendingConfirm?.holdId).toBe('hold-1');
  });

  it('stops re-sending once it has tried as often as is useful', async () => {
    const session = readySession();
    session.pendingConfirm = {
      holdId: 'hold-1',
      service: 'D1110',
      startsAtUtc: '2026-08-03T15:00:00Z',
      attempts: CONFIRM_ATTEMPT_LIMIT,
    };

    const api = {
      confirmAppointment: async () => {
        throw new Error('should not be called');
      },
    } as unknown as CedarRidgeClient;

    const result = await call(api, session, 'confirmAppointment');

    expect(result.ok).toBe(false);
    expect(String(result.guidance)).toContain(PRACTICE.phone);
  });

  it('counts the attempts it has made', async () => {
    const session = held(readySession());
    const api = failing(503, 'UNKNOWN');

    await call(api, session, 'confirmAppointment');
    expect(session.pendingConfirm?.attempts).toBe(1);

    await call(api, session, 'confirmAppointment');
    expect(session.pendingConfirm?.attempts).toBe(2);
  });

  it('is answered by a booking for that slot, not by any booking at all', async () => {
    const session = readySession();
    session.pendingConfirm = {
      holdId: 'hold-2',
      service: 'D1110',
      startsAtUtc: '2026-08-10T15:00:00Z',
      attempts: 1,
    };
    // An earlier appointment, at a different time. It says nothing about the
    // second booking's outcome, so the guard must still hold.
    session.booked = [
      {
        id: 'a1',
        service: 'Cleaning',
        startsAtUtc: '2026-08-03T15:00:00Z',
        provider: 'Dr Chen',
        price: 'Self-pay. Patient owes $125.00.',
      },
    ];
    session.slotRefs.set('1', { slotId: 'slot-9', startsAtUtc: '2026-08-11T15:00:00Z' });

    const result = await call(stalledConfirm(), session, 'holdSlot', {
      ref: '1',
      service: 'D1110',
    });

    expect(result.ok).toBe(false);
  });
});
