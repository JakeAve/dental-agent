import { tool } from 'ai';
import { z } from 'zod';
import { CedarRidgeError, type Appointment, type CedarRidgeClient } from '../cedar-ridge';
import { WIDENED_SEARCH_DAYS } from '../config';
import { insuranceBlocks, type Session } from '../session';
import { addDays, partOfDay, practiceDate, toPracticeTime } from '../time';
import { withRecovery } from './errors';

/** Money comes back from the API in cents; never let the model divide. */
const dollars = (cents: number | undefined) =>
  cents === undefined ? undefined : `$${(cents / 100).toFixed(2)}`;

/**
 * Three distinct outcomes, and the model must not blur them: a covered service
 * costs a copay, an uncovered service on an active plan costs full price, and
 * self-pay costs full price. The middle case surprises patients, so it gets
 * language that says the plan is active *and* does not help here.
 */
function describePrice(appt: Appointment) {
  if (appt.copay !== undefined) {
    return `Covered by insurance. Copay ${dollars(appt.copay)}.`;
  }
  if (appt.coverage === 'not_covered') {
    return `Insurance is active but does not cover this service. Patient owes ${dollars(appt.self_pay_price)} in full.`;
  }
  return `Self-pay. Patient owes ${dollars(appt.self_pay_price)}.`;
}

function summarize(appt: Appointment) {
  return {
    service: appt.service_name,
    // Preformatted in the practice's timezone — read this back verbatim.
    startsAt: toPracticeTime(appt.starts_at),
    durationMinutes: appt.duration_minutes,
    provider: appt.provider.name,
    status: appt.status,
    price: describePrice(appt),
  };
}

/**
 * Confirms a hold, and settles the record of whether it was ever answered.
 *
 * Any reply resolves that question, an error included: a 409 or a 410 is the
 * API telling us where it stands, and the ambiguity worth guarding against is
 * silence — a turn killed by its deadline mid-request. So the pending marker is
 * cleared on both paths here, and left standing only when nothing came back at
 * all. Without that distinction, an expected 409 on a superseded hold would
 * lock the conversation out of booking the slot the patient actually chose.
 */
async function confirmed(
  api: CedarRidgeClient,
  holdId: string,
  notes: string | undefined,
  session: Session,
) {
  try {
    const appt = await api.confirmAppointment({ hold_id: holdId, notes });
    session.pendingConfirm = undefined;
    return appt;
  } catch (err) {
    if (err instanceof CedarRidgeError) session.pendingConfirm = undefined;
    throw err;
  }
}

const NO_PATIENT = {
  ok: false as const,
  problem: 'No patient record exists yet in this conversation.',
  guidance:
    "Collect the patient's details and call registerPatient first; every " +
    'scheduling step needs a patient on file.',
};

export function appointmentTools(api: CedarRidgeClient, session: Session) {
  /**
   * Short references for slots, rebuilt on every search and kept on the session.
   *
   * The model never sees a slot UUID. Asked to copy one across turns it garbles
   * it — which surfaced as a 404 on hold, relayed to the patient as "there was
   * a problem, can you confirm your details again". A one-character ref it can
   * copy reliably; the real id never leaves this file.
   */
  const slotRefs = session.slotRefs;

  return {
    findAvailability: tool({
      description:
        'Find open appointment times for a service. Appointment length differs ' +
        'for new versus returning patients — new patients need much longer ' +
        'visits and therefore have far fewer openings. Never propose a time ' +
        'that did not come from this tool. Times come back already converted to ' +
        "the practice's local timezone; read them back exactly as given. " +
        'Results are chronological and come ten at a time, so the first page of ' +
        'a wide window may only reach a day or two in: to find a time later in ' +
        'the window, either narrow from/to onto the days the patient wants or ' +
        'ask for the next page. An empty window is widened automatically, so ' +
        'an empty result really means empty.',
      inputSchema: z.object({
        service: z.string().describe('A service code from listServices, e.g. D1110'),
        from: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
        to: z
          .string()
          .optional()
          .describe('YYYY-MM-DD, defaults to only 14 days out'),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Which page of results, 1 by default. Ten slots a page, earliest ' +
              'first. Use this to look further into the same window; refs from ' +
              'pages you already fetched stay valid.',
          ),
      }),
      execute: ({ service, from, to, page }) =>
        withRecovery(async () => {
          if (!session.patient) return NO_PATIENT;

          // Checked in memory rather than by calling the API and eating a 422 —
          // the run has a finite request budget.
          if (insuranceBlocks(session)) {
            return {
              ok: false as const,
              problem: 'Insurance is not settled for this patient yet.',
              guidance:
                'Call verifyInsurance first — payerId plus memberId, or ' +
                'selfPay true — then search again.',
            };
          }

          const search = (window: { from?: string; to?: string }) =>
            api.getAvailability({
              service,
              patient_id: session.patient!.id,
              from: window.from,
              to: window.to,
              page,
            });

          let result = await search({ from, to });
          let searched = { from, to };
          let widened = false;

          // An empty first page used to be answered with a paragraph asking the
          // model to search again over 30 to 60 days. It usually did. "Usually"
          // is the problem: the cost of forgetting is telling a patient the
          // practice is full when it has openings all month, and one extra call
          // buys the certainty. Only from the first page, because a later page
          // coming back empty means the window ran out of pages, not of days.
          if (result.availability.length === 0 && (page ?? 1) === 1) {
            const wideFrom = from ?? practiceDate();
            const wideTo = addDays(wideFrom, WIDENED_SEARCH_DAYS);

            // Skipped when the caller already asked for at least this much: a
            // repeat of the same search would spend a call to learn nothing.
            if (!to || to < wideTo) {
              widened = true;
              searched = { from: wideFrom, to: wideTo };
              result = await search(searched);
            }
          }

          // Paging within one search accumulates refs; changing the search
          // discards them, because the patient is no longer being offered those
          // times. Keyed on the window actually searched, not the one asked
          // for, or a widened search's refs would be filed under a window that
          // never produced them.
          const searchKey = `${service}|${searched.from ?? ''}|${searched.to ?? ''}`;
          if (session.slotSearch !== searchKey) {
            slotRefs.clear();
            session.slotSearch = searchKey;
          }

          const pagesLeft = result.total_pages - result.page;

          if (result.availability.length === 0) {
            // Two different dead ends, and conflating them sent the agent off to
            // widen a window that was never the problem.
            return {
              slots: [],
              page: result.page,
              totalPages: result.total_pages,
              searchedFrom: searched.from ?? 'today',
              searchedTo: searched.to ?? '14 days out (the default)',
              widenedTo: widened ? `${WIDENED_SEARCH_DAYS} days` : undefined,
              guidance:
                // An empty first page means an empty window whatever the page
                // count says; only a later page can have run off the end.
                result.page > 1 && result.page > result.total_pages
                  ? `There is no page ${result.page} — this search has ` +
                    `${result.total_pages}. The times you already fetched are ` +
                    'still on offer; go back to an earlier page, or search a ' +
                    'different window.'
                  : widened
                    ? `Nothing open in the next ${WIDENED_SEARCH_DAYS} days — ` +
                      'this search was already widened to that automatically, so ' +
                      'widening again will return the same nothing. This is a ' +
                      'real dead end: say so, and offer the office number.'
                    : 'Nothing open in that window, and it was not widened ' +
                      'because you asked for a wider one already. Say so plainly ' +
                      'rather than searching it again.',
            };
          }

          // A slot keeps the ref it was first given. Pages of one search can
          // overlap, and the same page may be fetched twice — either way the
          // patient must not hear the same time offered under two refs.
          const refFor = new Map(
            [...slotRefs].map(([ref, slot]) => [slot.slotId, ref]),
          );
          let nextRef = slotRefs.size;

          const slots = result.availability.map((s) => {
            const ref = refFor.get(s.slot_id) ?? String(++nextRef);
            slotRefs.set(ref, { slotId: s.slot_id, startsAtUtc: s.starts_at });

            return {
              ref,
              startsAt: toPracticeTime(s.starts_at),
              partOfDay: partOfDay(s.starts_at),
              durationMinutes: s.duration_minutes,
              provider: s.provider.name,
            };
          });

          return {
            slots,
            page: result.page,
            totalPages: result.total_pages,
            searchedFrom: searched.from ?? 'today',
            searchedTo: searched.to ?? '14 days out (the default)',
            guidance:
              // Said first when it happened, because the patient asked about a
              // window these times are not in, and hearing them offered as
              // though they were is worse than hearing the window was empty.
              (widened
                ? 'Nothing was open in the window you asked about, so this ' +
                  `search was widened to the next ${WIDENED_SEARCH_DAYS} days ` +
                  'automatically. Tell the patient their window had nothing ' +
                  'and that these are the nearest openings after it — do not ' +
                  'present them as if they were what was asked for. '
                : '') +
              'Offer these to the patient by time and provider; the ref is for ' +
              'your own use when calling holdSlot. If the patient stated a ' +
              'time-of-day preference and no slot matches, that is NOT "no ' +
              'availability": say their preferred window is not open, offer the ' +
              'closest actual times, and let them choose. A preference is never ' +
              'a reason to withhold a real opening or to escalate.' +
              (pagesLeft > 0
                ? ` These are the earliest ${slots.length} of this window, and ` +
                  `${pagesLeft} more page(s) follow — so this is NOT the whole ` +
                  'schedule. If the patient wants a day or a time of day that is ' +
                  'not here, do not tell them it is unavailable: search again ' +
                  'with from/to narrowed onto the days they asked about (one ' +
                  'call, and the most precise option), or fetch the next page. ' +
                  'Refs you already have stay valid either way.'
                : ' This is the last page of this window.'),
          };
        }, 'findAvailability'),
    }),

    holdSlot: tool({
      description:
        'Reserve one of the slots from the most recent availability search, by ' +
        'its ref. The hold lasts five minutes and does not book anything — you ' +
        'must call confirmAppointment before it expires. Holding a new slot ' +
        "releases this patient's previous hold automatically, so offering an " +
        'alternative time is safe.',
      inputSchema: z.object({
        ref: z
          .string()
          .describe('The ref of the chosen slot, from the latest findAvailability'),
        service: z.string().describe('The same service code used to find the slot'),
      }),
      execute: ({ ref, service }) =>
        withRecovery(async () => {
          if (!session.patient) return NO_PATIENT;

          // Refused rather than discouraged. A hold taken while a submitted
          // booking's outcome is unknown is the first step of a duplicate
          // booking, and prompt wording is not a guarantee — this is.
          if (session.pendingConfirm && !session.booked.length) {
            return {
              ok: false as const,
              problem:
                'A booking was already submitted for this patient and its ' +
                'outcome is still unknown.',
              guidance:
                'Call confirmAppointment first. Confirming the same hold twice ' +
                'is safe and returns the existing appointment if there is one. ' +
                'Holding another slot now risks booking this patient twice.',
            };
          }

          const slot = slotRefs.get(ref.trim());
          if (!slot) {
            return {
              ok: false as const,
              problem: `There is no slot with ref "${ref}" in the current list.`,
              guidance:
                'Call findAvailability again and hold one of the refs it ' +
                'returns. Do not guess a ref.',
            };
          }

          const hold = await api.holdSlot({
            slot_id: slot.slotId,
            patient_id: session.patient.id,
            service,
          });

          session.hold = {
            holdId: hold.hold_id,
            slotId: slot.slotId,
            service,
            startsAtUtc: slot.startsAtUtc,
            expiresAtMs: Date.now() + hold.expires_in_seconds * 1000,
          };

          return {
            held: toPracticeTime(slot.startsAtUtc),
            expiresInSeconds: hold.expires_in_seconds,
            next: 'If the patient has already said yes, call confirmAppointment now.',
          };
        }, 'holdSlot'),
    }),

    confirmAppointment: tool({
      description:
        'Book the currently held slot. Only call this once the patient has ' +
        'agreed to the specific date and time. The response states what they ' +
        'will owe — always relay the confirmed time, the provider, and the ' +
        'price back to them.',
      inputSchema: z.object({
        notes: z
          .string()
          .max(255)
          .optional()
          .describe('Optional note for the office'),
      }),
      execute: ({ notes }) =>
        withRecovery(async () => {
          // The model will occasionally try to confirm before holding anything.
          // The API would reject it, but that burns a call from a metered
          // budget and reads to the patient as a failed booking.
          //
          // A submitted booking whose answer never arrived counts as something
          // to confirm even when the hold is gone or looks lapsed: re-sending
          // it is the only way to find out whether it exists, and the API
          // documents that as safe.
          const target = session.hold ?? session.pendingConfirm;

          if (!target) {
            return {
              ok: false as const,
              problem: 'There is no active hold to confirm.',
              guidance:
                'Nothing is reserved yet. Call findAvailability, then holdSlot ' +
                'on the time the patient chose, and confirm that.',
            };
          }

          // Recorded before the call, not after. The deadline can fire while
          // this request is in flight, and the far end does not stop: the
          // appointment may exist with its id in a response nobody read.
          session.pendingConfirm = {
            holdId: target.holdId,
            service: target.service,
            startsAtUtc: target.startsAtUtc,
          };

          const appt = await confirmed(api, target.holdId, notes, session);

          if (!session.booked.some((b) => b.id === appt.id)) {
            session.booked.push({
              id: appt.id,
              service: appt.service_name,
              startsAtUtc: appt.starts_at,
              provider: appt.provider.name,
              price: describePrice(appt),
            });
          }
          session.hold = undefined;
          session.resolved = true;

          // The id, deliberately, and only here. The sandbox is persistent and
          // has no endpoint that lists appointments — an id that exists solely
          // in a process's memory is unrecoverable the moment that process
          // restarts, leaving a slot booked forever. This is a server log, not
          // customer-facing text, and an appointment id is not a credential.
          console.log(
            `[confirmAppointment] booked ${appt.id} @ ${appt.starts_at}`,
          );

          return summarize(appt);
        }, 'confirmAppointment'),
    }),

    getAppointment: tool({
      description:
        'Re-read the appointment booked in this conversation, to check what ' +
        'actually went through before risking a duplicate booking.',
      inputSchema: z.object({}),
      execute: () =>
        withRecovery(async () => {
          const latest = session.booked.at(-1);
          if (!latest) {
            return {
              ok: false as const,
              problem: 'No booking from this conversation is on record here.',
              guidance:
                'This means you have no record of one — NOT that the patient ' +
                'has no appointment. Never tell them they have nothing booked; ' +
                'you cannot see appointments made elsewhere or earlier. If they ' +
                'believe they have one, send them to the front desk. If they ' +
                'want a new appointment, start from findAvailability.',
            };
          }

          return summarize(await api.getAppointment(latest.id));
        }, 'getAppointment'),
    }),

    cancelAppointment: tool({
      description:
        'Cancel the appointment booked in this conversation and reopen its ' +
        'slot. State the specific appointment being cancelled and get an ' +
        'explicit yes before calling this.',
      inputSchema: z.object({}),
      execute: () =>
        withRecovery(async () => {
          const latest = session.booked.at(-1);
          if (!latest) {
            // Absence of a record is not evidence of absence. There is no
            // endpoint that lists a patient's appointments, so a booking made
            // before this conversation — or on another instance of this
            // service — is invisible here. Claiming it does not exist told one
            // patient their real, confirmed appointment was not booked.
            return {
              ok: false as const,
              problem: 'No appointment from this conversation is on record here.',
              guidance:
                'Do NOT tell the patient nothing is booked — you cannot see ' +
                'that. Say you are not able to pull their appointment up, ' +
                'apologise, and give them the office number so the front desk ' +
                'can cancel it. Never leave them believing a real appointment ' +
                'was never made.',
            };
          }

          const appt = await api.cancelAppointment(latest.id);
          session.booked = session.booked.filter((b) => b.id !== latest.id);
          session.resolved = true;

          return summarize(appt);
        }, 'cancelAppointment'),
    }),
  };
}
