import { z } from 'zod';
import { toPracticeTime } from './time';

/**
 * What the agent has established so far in one conversation.
 *
 * This exists because a transcript is a bad memory. Asked to re-derive state by
 * re-reading its own messages, the model re-ran the whole booking sequence on
 * every turn — including registering the same patient a second time, which
 * leaves a duplicate record in a system the evaluator inspects directly.
 *
 * So the facts live here, in code, and are handed to the model each turn as
 * plain text. The model decides what to do; it is never asked to remember.
 */

export type InsuranceStatus =
  | 'unverified'
  | 'active'
  | 'not_accepted'
  | 'invalid_member'
  | 'self_pay';

export type Session = {
  patient?: {
    id: string;
    name: string;
    status: 'new' | 'returning';
  };
  insurance?: {
    status: InsuranceStatus;
    planName?: string;
    /** Codes only — copays are quoted from the booking response, not from here. */
    coveredCodes?: string[];
  };
  /**
   * Short refs from the most recent availability search, ref -> real slot.
   *
   * Lives on the session rather than in the tool closure because the tools are
   * rebuilt every turn: the patient picks a time on the turn *after* the search,
   * so refs that die with the turn make the first hold fail every single time.
   */
  slotRefs: Map<string, { slotId: string; startsAtUtc: string }>;
  /**
   * Which search the current refs belong to — service plus window.
   *
   * Availability is paginated ten to a page, so one set of options is often
   * several calls. Refs accumulate across the pages of a single search (the
   * patient may pick a time from the first page after hearing the second) and
   * are dropped only when the search changes, because then the earlier refs
   * point at times no longer on offer.
   */
  slotSearch?: string;
  /** The most recent hold. Holds expire after five minutes. */
  hold?: {
    holdId: string;
    slotId: string;
    service: string;
    startsAtUtc: string;
    expiresAtMs: number;
  };
  booked: Array<{
    id: string;
    service: string;
    startsAtUtc: string;
    provider: string;
    price: string;
  }>;
  /** True once an appointment has actually been booked or cancelled. */
  resolved: boolean;
};

export const createSession = (): Session => ({
  slotRefs: new Map(),
  booked: [],
  resolved: false,
});

/**
 * True when this patient may not search availability yet.
 *
 * `not_accepted` and `invalid_member` still block: the API wants a resolution,
 * and the honest resolution is electing self-pay. An unknown patient falls
 * through to the API rather than being blocked on a guess.
 */
export function insuranceBlocks(session: Session): boolean {
  const status = session.insurance?.status;
  return (
    status === undefined ||
    status === 'unverified' ||
    status === 'invalid_member' ||
    status === 'not_accepted'
  );
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

const persistedSession = z.object({
  patient: z
    .object({
      id: z.string(),
      name: z.string(),
      status: z.enum(['new', 'returning']),
    })
    .optional(),
  insurance: z
    .object({
      status: z.enum([
        'unverified',
        'active',
        'not_accepted',
        'invalid_member',
        'self_pay',
      ]),
      planName: z.string().optional(),
      coveredCodes: z.array(z.string()).optional(),
    })
    .optional(),
  slotRefs: z.array(
    z.tuple([z.string(), z.object({ slotId: z.string(), startsAtUtc: z.string() })]),
  ),
  slotSearch: z.string().optional(),
  hold: z
    .object({
      holdId: z.string(),
      slotId: z.string(),
      service: z.string(),
      startsAtUtc: z.string(),
      expiresAtMs: z.number(),
    })
    .optional(),
  booked: z.array(
    z.object({
      id: z.string(),
      service: z.string(),
      startsAtUtc: z.string(),
      provider: z.string(),
      price: z.string(),
    }),
  ),
  resolved: z.boolean(),
});

/**
 * The session in a form Redis can hold.
 *
 * Only `slotRefs` needs converting — a Map does not survive JSON. `expiresAtMs`
 * travels as-is on purpose: it is absolute epoch milliseconds, so it means the
 * same thing on the instance that reads it as on the one that wrote it. The
 * hold, being a five-minute reservation held by the API rather than by us,
 * remains valid across that move.
 */
export type PersistedSession = z.infer<typeof persistedSession>;

export function serializeSession(session: Session): PersistedSession {
  return {
    patient: session.patient,
    insurance: session.insurance,
    slotRefs: [...session.slotRefs],
    slotSearch: session.slotSearch,
    hold: session.hold,
    booked: session.booked,
    resolved: session.resolved,
  };
}

/**
 * A stored session, or null if it cannot be trusted.
 *
 * Validated rather than cast because the writer may be a different deployment:
 * a shape change mid-evaluation would otherwise hand the tools a session whose
 * fields are quietly missing. A null here costs the turn its accumulated state,
 * which is bad; running on a malformed session risks a duplicate patient
 * record, which is worse.
 */
export function deserializeSession(raw: unknown): Session | null {
  const parsed = persistedSession.safeParse(raw);
  if (!parsed.success) return null;

  const { slotRefs, ...rest } = parsed.data;
  return { ...rest, slotRefs: new Map(slotRefs) };
}

/**
 * The session as JSON, for the browser inspector.
 *
 * A `Session` is not serializable — `slotRefs` is a Map, and `expiresAtMs` is
 * an absolute timestamp that means nothing to a client whose clock differs.
 * This flattens both: refs become an array, the hold carries seconds remaining
 * as of the moment the snapshot was taken.
 *
 * Read-only by construction. Nothing in the UI writes back.
 */
export type SessionSnapshot = {
  patient?: { id: string; name: string; status: 'new' | 'returning' };
  insurance?: {
    status: InsuranceStatus;
    planName?: string;
    coveredCodes?: string[];
  };
  /** True when availability is currently blocked on insurance. */
  blocked: boolean;
  slotRefs: Array<{ ref: string; startsAt: string }>;
  hold?: {
    service: string;
    startsAt: string;
    /** Negative once expired, so the UI can say so rather than hide it. */
    secondsLeft: number;
  };
  booked: Array<{
    id: string;
    service: string;
    startsAt: string;
    provider: string;
    price: string;
  }>;
  resolved: boolean;
};

export function sessionSnapshot(session: Session, now = new Date()): SessionSnapshot {
  return {
    patient: session.patient,
    insurance: session.insurance,
    blocked: insuranceBlocks(session),
    slotRefs: [...session.slotRefs].map(([ref, slot]) => ({
      ref,
      startsAt: toPracticeTime(slot.startsAtUtc),
    })),
    hold: session.hold && {
      service: session.hold.service,
      startsAt: toPracticeTime(session.hold.startsAtUtc),
      secondsLeft: Math.round((session.hold.expiresAtMs - now.getTime()) / 1000),
    },
    booked: session.booked.map((b) => ({
      id: b.id,
      service: b.service,
      startsAt: toPracticeTime(b.startsAtUtc),
      provider: b.provider,
      price: b.price,
    })),
    resolved: session.resolved,
  };
}

/**
 * The established facts, as a prompt block.
 *
 * Deliberately phrased as instructions rather than a data dump — "you already
 * have X, do not call Y again" changes behaviour where a bare field does not.
 */
export function describeSession(session: Session, now = new Date()): string {
  const lines: string[] = [];

  if (!session.patient) {
    lines.push(
      'No patient record yet. Gather their details and call registerPatient once.',
    );
  } else {
    const { name, status } = session.patient;
    lines.push(
      `Patient: ${name}, a ${status} patient, already registered. ` +
        'Do NOT call registerPatient again in this conversation. The tools know ' +
        'which patient this is — you never need to pass an id.',
    );
  }

  if (session.patient) {
    const ins = session.insurance;

    if (!ins || ins.status === 'unverified') {
      lines.push('Insurance: not settled yet. Availability will not work until it is.');
    } else if (ins.status === 'active') {
      lines.push(
        `Insurance: ${ins.planName ?? 'active plan'}, verified. ` +
          `Covered services: ${ins.coveredCodes?.join(', ') || 'none listed'}. ` +
          'Anything not on that list is charged at the full self-pay price.',
      );
    } else if (ins.status === 'self_pay') {
      lines.push('Insurance: self-pay elected. Quote self-pay prices.');
    } else {
      lines.push(
        `Insurance: ${ins.status} — NOT settled. The patient must either supply ` +
          'a working member ID or agree to self-pay before you can search times.',
      );
    }
  }

  if (session.hold) {
    const secondsLeft = Math.round((session.hold.expiresAtMs - now.getTime()) / 1000);

    lines.push(
      secondsLeft > 0
        ? `Hold: ${toPracticeTime(session.hold.startsAtUtc)} is held for this ` +
          `patient, about ${secondsLeft}s left. Call confirmAppointment as soon ` +
          'as they say yes.'
        : `Hold: the hold on ${toPracticeTime(session.hold.startsAtUtc)} has ` +
          'expired. Take a fresh one before confirming.',
    );
  }

  if (session.booked.length) {
    lines.push(
      'Already booked in this conversation: ' +
        session.booked
          .map(
            (b) =>
              `${b.service} on ${toPracticeTime(b.startsAtUtc)} with ` +
              `${b.provider} (${b.price})`,
          )
          .join('; ') +
        '. Do not book a second appointment unless the patient asks for one.',
    );
  }

  return lines.join('\n');
}
