# Addressable bookings: naming which appointment to read or cancel

Design for `improvements.md` §3. Implements booking refs, a required selector on
`getAppointment` and `cancelAppointment`, a disambiguation refusal, the safe reschedule
ordering, and the tests — unit and e2e — that pin all of it.

## The problem

`getAppointment` (`lib/tools/appointments.ts:499`) and `cancelAppointment` (`:524`) both
take `inputSchema: z.object({})` and both open with `session.booked.at(-1)`. The session
carries the full list, and `describeSession` reads every entry into the prompt — so the
agent is shown every booking and given no way to name one.

Book a cleaning, then an exam, then say "cancel the cleaning": the agent says it is
cancelling the cleaning, calls a tool that takes no argument, and the exam is cancelled
instead. `summarize` returns the exam's details and the agent relays them as the
cancellation it just performed. The write is irreversible, both of the agent's statements
are confident and wrong, and the logs record a success. `getAppointment` fails the same
way more quietly: asked "is my cleaning still on?", it reads the exam.

Nothing tests this. `appointments.test.ts` never constructs a session with two bookings,
and no e2e scenario books twice.

**Constraint from existing design:** the appointment id must not become a tool argument.
`summarize` omits it deliberately, the id is logged and nowhere else
(`appointments.ts:478`), and `slotRefs` exists precisely because the model garbles UUIDs
across turns — which surfaced as a 404 on hold, relayed to the patient as "there was a
problem, can you confirm your details again". Handing the model an appointment UUID would
reintroduce that failure on the path where it costs the most.

## 1. The ref

Each entry in `session.booked` gains `ref: string` — `B1`, `B2`, … — assigned once, where
the entry is pushed in `confirmAppointment`. The `B` prefix keeps them distinguishable
from slot refs, which are bare numbers, so the two can never be confused in a prompt.

Numbering comes from a persisted counter on the session (`nextBookingRef`), **not** from
`booked.length` and **not** from `max(existing) + 1`. `cancelAppointment` filters the
array, so either derivation would eventually hand `B2` to a second appointment after the
first `B2` was cancelled — the original bug wearing a disguise. The rule is the one
`slotRefs` already establishes: a booking keeps the ref it was first given.

Persistence: `ref` and `nextBookingRef` are added to `persistedSession` as **optional**,
exactly as `holdId` was (`session.ts:225`), so a session written before this change still
restores. `deserializeSession` backfills a ref for any booked entry lacking one and seeds
the counter above the highest it assigned. Everything downstream can then treat
`ref: string` as guaranteed on the in-memory `Session` type.

The real appointment id still never leaves `appointments.ts`.

## 2. Tool contract

Both tools take the same argument:

```ts
inputSchema: z.object({
  booking: z
    .string()
    .describe('The ref of the appointment, e.g. B1, from the booked list'),
})
```

**Required, not optional.** `holdSlot` already requires a `ref` and refuses unknown ones;
a selector on the irreversible call must not be softer than the selector on a hold. A
single-booking default was considered and rejected: defaulting is the exact mechanism this
change exists to remove — the tool choosing a target the model never named. With one
booking the model has one ref in front of it in the prompt; a model that cannot transcribe
that was never going to survive the two-booking case.

The model omitting a required field is an SDK-level validation error and outside our
guidance. What is inside it: an empty or whitespace `booking` is treated as *not named*
and answered with the disambiguation guidance below, so every mistake the model can
plausibly make lands in our own refusal path.

Runtime branches, identical in both tools:

| state | behaviour |
| --- | --- |
| nothing booked | today's guidance, unchanged — "absence of a record is not evidence of absence", never "you have nothing booked" |
| ref names a booking | act on it |
| ref blank | refuse; list every ref with its service and time |
| ref unknown | refuse; name the refs that do exist and say not to guess (mirrors `appointments.ts:368`) |

Refusal tone matters and is part of the spec: *"I have two on file — which one?"* is a fine
thing to say to a patient; *"you have nothing booked"* is the sentence that already went
wrong once. A refusal makes no API call and mutates nothing.

`cancelAppointment`'s success result carries the ref it acted on alongside
`summarize(appt)`, with guidance to build the confirmation sentence from that result rather
than from intent. That is the second line of defence: a transcription error then produces a
reply that names the appointment actually cancelled, instead of one that misreports it.

## 3. `describeSession`

The booked line becomes ref-led, so the model reads the selector in the same breath as the
thing it selects:

> Already booked in this conversation: `B1` — Adult Cleaning on Thursday, July 30, 2026 at
> 9:00 AM MDT with Maria Gonzalez RDH ($0.00 copay); `B2` — Comprehensive Exam on Tuesday,
> August 4, 2026 at 2:00 PM MDT with Dr Chen ($125.00). To read or cancel one, pass its ref.
> Do not book a second appointment unless the patient asks for one.

## 4. Reschedule

Guidance, not a new tool — a reschedule spans an availability search, so no single call can
be atomic and a tool that pretended otherwise would be a state marker with a misleading
name.

The safe order, stated on `cancelAppointment`'s description and as a rule in the system
prompt: **find availability, hold the new slot, confirm the new appointment, and only then
cancel the old one by its ref.** Never cancel first. Cancel first and an empty search, an
expired hold, or a deadline mid-flight leaves the patient with nothing after being told they
were being moved. A patient briefly holding two appointments is recoverable by anyone; a
patient holding none who was told otherwise is the failure that reaches the front desk. The
brief double-booking is the accepted lesser harm and is stated in the guidance rather than
left to be discovered.

## 5. Tests

### Unit — `lib/tools/appointments.test.ts`, no model

1. Two bookings, cancel `B1`: the API is called with `B1`'s id, and `B2` survives in
   `session.booked`.
2. Two bookings, blank ref: `ok: false`, both refs named in the message, **no** API call,
   `session.booked` unchanged.
3. Two bookings, unknown ref: refused, no API call.
4. One booking, its own ref: cancels it.
5. Nothing booked: today's guidance, unchanged.
6. `getAppointment` selects by ref the same way, and refuses the same way.
7. Refs survive `serializeSession` → `deserializeSession`.
8. A persisted session written without refs restores with refs backfilled.
9. After cancelling `B2`, the next booking is **not** `B2`.

### e2e — new persona S42, new spec `e2e/cancel.spec.ts`

Returning patient, self-pay. Books a cleaning; then asks for a comprehensive exam as well;
then says "actually, cancel the cleaning — keep the exam." `maxBookings: 2`, `maxTurns: 12`.

Verdict is API ground truth only, never prose: fetch both created ids, assert the `D1110`
cleaning is `cancelled` and the `D0150` exam is still `confirmed`, and that exactly one
`DELETE /appointments/:id` was made. Plus the standard `assertHealthy` guards.

This test fails today: `at(-1)` kills the exam.

**Risk to resolve first.** Whether the sandbox permits a patient two concurrent confirmed
appointments is unverified — personas use fixed identities, and the known constraint is one
*hold* at a time. Probe this before writing the persona. If a second booking is refused,
the scenario cannot be written as specified and the shape needs a decision from the user
rather than a guess.

## 6. Cleanup ends in a verified state

This is the first scenario where an appointment is cancelled **by the agent** before
teardown, so `cleanup()` (`e2e/support/run.ts:127`) will DELETE something already
cancelled. Today it tolerates only `404`/`NOT_FOUND`, so a likely `409` counts as a
failure: an alarming warning on a passing test, `markReleased` never called, and therefore a
permanent entry in `created.jsonl` that makes `globalSetup` warn on every future run and
`npm run e2e:cleanup` exit 1 forever.

So cleanup stops trusting the DELETE and confirms the outcome instead. For each id the run
created:

1. DELETE it.
2. On any error, `GET /appointments/{id}`: `status === 'cancelled'` counts as released, and
   so does a `404`.
3. Anything else — still `confirmed`, or unreadable — is a real leak: shouted about, left
   unreleased in the ledger, and therefore swept by `npm run e2e:cleanup`.

The invariant, positively: **when the suite finishes, every appointment it created is
provably cancelled or provably gone, or a human has been told about it.** The same logic
goes into `scripts/e2e-cleanup.ts`, extracted into one shared function so the two cannot
drift.

Two supporting pieces:

- When the proxy observes a successful `DELETE /appointments/:id`, it marks that id released
  in the ledger there and then (`proxy.ts:224` already records creations the same way). A
  crash immediately after the agent's own cancel then leaves no phantom entry for the sweep.
- The new spec assigns `created = run.appointmentIds` in the existing `afterEach` pattern.
  If `runScenario` throws before that, the ids are still on disk — the proxy writes them the
  instant it sees a booking, before the test finishes.

## Known cost

The multi-booking case can now take an extra turn when the agent has to ask which
appointment. That is the point: asking costs a turn, cancelling the wrong appointment costs
a patient their slot and the practice its credibility.
