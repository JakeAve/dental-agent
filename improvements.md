# Improvements

Proposals, not commitments. Each entry states what exists today, what would replace
it, and what the replacement costs.

---

## 1. Let the model declare whether it is waiting on the patient

### What exists

`awaitingReply` in `lib/reply.ts:95` decides `complete` vs `continue` by reading the
reply as English:

```ts
export function awaitingReply(message: string): boolean {
  return message.includes('?') || ASKS_FOR_A_REPLY.test(message);
}
```

`ASKS_FOR_A_REPLY` (`lib/reply.ts:84`) is a hand-grown alternation of phrasings —
`please confirm`, `let me know`, `just confirm`, `tell me which`, `say the word`,
`i'll need`. It exists because of a production failure: after a booking, asked to
cancel it, the agent said *"Please confirm you want me to cancel that appointment."*
and the run was reported `complete` on a turn plainly waiting for a yes.

Its one caller is `app/api/evaluation-turn/route.ts:315`:

```ts
status: run.session.resolved && !awaitingReply(message) ? 'complete' : 'continue',
```

Two failure modes remain, and they are the two directions the same guess can be
wrong in:

- **Misses the next phrasing.** "Shall I go ahead and cancel it" with a period,
  "Just say yes and I'll cancel it", "Confirm and I'll take care of it" — none of
  them match, and each is a run closed with a question outstanding. The pattern was
  already patched once from production; nothing about the next phrasing is in it.
- **Cannot tell a rhetorical question from a real one.** Any `?` anywhere pins the
  turn on `continue`. "Booked — who doesn't love a clean tooth?" is finished work
  reported as still in progress, and it stays that way for every remaining turn.

The interesting property of the call site is that `awaitingReply` only runs when
`run.session.resolved` is already true — set by `confirmAppointment` and the cancel
path (`lib/tools/appointments.ts:476`, `:545`). Before a booking or cancellation has
actually happened the status is `continue` regardless of what the reply says. So the
decision matters on a handful of turns per run at most, and on no others.

### What would replace it

A second, structured call made only on the turns where the answer can change
anything. After the reply is drafted in `route.ts`, if and only if
`run.session.resolved`, ask the model one question about the text it just wrote —
*are you waiting on the patient's answer?* — with a boolean schema and no tools
(`generateObject`, or `generateText` with `output: Output.object(...)`; both are
available in `ai@7`). The regex and `awaitingReply` are deleted.

Guards, matching what the route already does elsewhere:

- **Budget.** The route already computes what the request has left
  (`agentBudgetMs`/`waitBudgetMs` off a single `startedAt` clock). The declaration
  call takes a slice of the remainder and is skipped if there isn't one.
- **Fallback is `continue`.** A failure, a timeout, or an unparseable answer falls
  back to `continue` — the bias the current comment already argues for: a run
  wrongly left open costs nothing, a run wrongly closed loses the turn's claim.
- **Cheap model.** A one-boolean classification does not need the agent model.

### Pros

- **The decision is declared, not inferred.** No English pattern to extend the next
  time production surprises us. The failure mode changes from "the phrasing wasn't in
  the list" to "the model got it wrong", which is the same class of judgment the
  agent is already trusted with for every booking it makes.
- **Rhetorical questions stop pinning the run.** A classifier can distinguish
  "How does that sound?" from "who doesn't love a clean tooth?"; `includes('?')`
  cannot, ever.
- **Prose generation is untouched.** `collapseRestartedReply` still sees ordinary
  text, so the gpt-5.4-mini double-draft bug stays repairable. The streaming chat
  route keeps sharing one prompt and one loop with the evaluation route.
- **Paid for only where it buys something.** Unresolved turns — the majority — do
  no extra work at all.
- **Testable without a live model.** The declaration becomes an injected function,
  so the route's tests keep asserting `complete`/`continue` against a stub, and the
  fallback-to-`continue` path is directly exercisable.

### Cons

- **One more round trip inside the 20-second budget**, on turns that have already
  spent time on a full tool loop. A timeout is not a lost turn — it ends the whole
  run as an endpoint error — so this has to be budget-guarded, not merely fast in
  practice.
- **A second thing that can fail.** Mitigated by falling back to `continue`, which
  is where the current code already errs, but it is another network call on the
  critical path.
- **Non-determinism where there was a regex.** The regex was wrong in ways you could
  read off the source; the classifier is wrong in ways you cannot predict. Reading
  the reply plus the drafted turn is a much easier task than the booking itself, so
  this is a real cost but a small one.
- **Slight cost per resolved turn.** Negligible next to the agent loop, non-zero.

### Alternatives considered

- **Structured output on the main call** — `output: Output.object({ message,
  awaitingPatient })` in `runAgentOnce`. One call, no added latency, which is
  genuinely attractive. Rejected because the reply then arrives as JSON: the
  observed double-draft bug would produce *invalid JSON* rather than repairable
  prose, turning a glitch we currently fix into a dead turn. It also forks
  `runAgentOnce` from the streaming chat path that shares its prompt.
- **An end-of-turn tool the agent calls to declare it is waiting** — free, in-loop,
  no extra call. Rejected because models skip end-of-turn tools, and the skip is
  silent: the absent declaration is indistinguishable from "not waiting", which is
  the exact direction we must not guess wrong in.
- **Deciding from session facts alone** — `resolved`, `pendingConfirm`, `hold`. Does
  not work: the session knows a booking happened, and cannot know the agent's reply
  asked a question about it. That is precisely the case the production bug came from.

---

## 2. One authoritative home per behaviour rule, plus a test per rule

### What exists

Take the `not_accepted` policy — an out-of-network plan is a *settled* answer, so
availability opens, the visit bills at the self-pay price, and the agent must never
ask the patient to switch to self-pay. That one rule is currently stated in four
places, in two different kinds of language.

The mechanical half already has an authoritative home, and this is the part that
works:

- `insuranceBlocks` (`lib/session.ts:162`) — code, one definition, and
  `lib/session.test.ts:27` asserts all five statuses exhaustively.

The conversational half is three independent prose renderings:

- `systemPrompt` (`lib/agent.ts:149`) — atemporal: *"`not_accepted` is an answer, not
  a failure … Tell them the practice does not take that plan **and** what the visit
  will cost, in the same turn. Do not … ask them to elect self-pay."*
- `describeSession` (`lib/session.ts:371`) — stateful, with the plan name
  interpolated: *"This IS settled … Say both things in the same breath … Do not ask
  them to switch to self-pay; nothing needs switching."*
- the `verifyInsurance` result note (`lib/tools/patients.ts:360`) — immediate: *"You
  can search times and book now … Tell the patient both things together … do not ask
  them to switch to self-pay; there is nothing to switch."*

All three currently agree. Nothing enforces that they keep agreeing. Of the three,
only `describeSession`'s is asserted (`lib/session.test.ts:44`, matching `/settled/i`,
`/self-pay price/i`, `/nothing needs switching/i`). The system-prompt rendering — the
one a maintainer is most likely to edit, since it reads as the document of record —
has no test at all, and neither does the tool note. An edit that softens "in the same
turn" in `agent.ts` and not in the other two leaves three subtly different policies in
one conversation, and every test still passes.

The prompt says of itself that it is an accumulation of incident patches, which was
the right way to get here. The cost is now visible: `## Things that will catch you
out` is ten unnumbered rules with no index, no ownership, and no per-rule coverage, so
there is no way to answer "does this rule contradict that one?" except by rereading
all of it. A related tell: `e2e/payers.spec.ts:28` checks the *behaviour* of this rule
by regex-matching the transcript for "not accepted"/"out of network" phrasings — the
same brittleness as item 1, one layer down.

### What would replace it

Not deduplication. Repetition genuinely helps a small model, and the three renderings
differ for good reasons — one is a standing rule, one describes a state that has
already happened, one reacts to a result just returned. Collapsing them to a single
shared paragraph would make each site read worse.

What can be shared is the part that must never drift: the *claims*. A rule module per
behaviour, declaring the invariant clauses once, with each site composing its own
prose from them.

```
lib/policy/not-accepted.ts
  id:      'insurance/not-accepted'
  guard:   the mechanical consequence, where one exists (insuranceBlocks)
  clauses: SETTLED, PRICED_AS_SELF_PAY, SAY_BOTH_TOGETHER, DO_NOT_ASK_TO_SWITCH
  standing(): string           → composed into systemPrompt
  established(ctx): string     → composed into describeSession
  onResult(result): string     → composed into the verifyInsurance note
```

Three things fall out of that:

1. **A drift test, with no model in it.** For every rule, assert that each rendering
   carries each of the rule's declared clauses. Deterministic, fast, and it fails on
   the edit that drops "in the same turn" from one site.
2. **A per-rule regression scenario.** The judged tier already exists and is the right
   shape for this — `e2e/behavior.spec.ts` grades a transcript against one explicit
   criterion at a time with a reason on failure. Today it carries six criteria across
   three scenarios. Give each registry rule a criterion there, and add a coverage
   guard that fails when a rule has no scenario. A prompt edit that breaks a behaviour
   then fails a named test rather than a patient.
3. **An enumerable list of rules.** Which is what makes "how do you know rule 14 does
   not contradict rule 6?" answerable at all — the rules become countable, each with
   an id, a home, and a test, rather than paragraphs in a wall of prose.

The migration is per rule, not wholesale: start with `not_accepted` (three sites, one
existing guard, one existing e2e), then the rules with the most renderings — the
member-ID rule, the pending-confirmation rule, and "no openings does not mean no
openings", which is stated in both the prompt and the availability tool.

### Pros

- **The drift that can happen silently becomes a test failure.** This is the whole
  point; everything else follows from it.
- **Repetition is kept, and stops being a liability.** Each site still says the rule
  in the register that suits it; only the source of the claims is shared.
- **The untested renderings get tested.** The system-prompt copy — the most-edited,
  currently least-covered — is the one this covers first.
- **Answers the maintainability question with an artefact.** A list of rule ids, each
  with a home and a scenario, is a better answer than "the prompt has been carefully
  reviewed".
- **Incremental, and reversible per rule.** Nothing forces a big-bang prompt rewrite;
  a rule that resists extraction stays prose.
- **Makes an LLM consistency audit possible later.** Contradiction-checking ten
  declared rules pairwise is a tractable nightly job; contradiction-checking a prose
  document is not.

### Cons

- **The prompt stops being one readable document.** This is the real cost. Right now
  you can read `agent.ts` top to bottom and know what the agent was told; composed
  from modules, you cannot. Mitigation: a script that prints the fully composed prompt
  (`npm run prompt`) and a snapshot test over it, so the assembled text stays
  reviewable in a diff — which is arguably better than today, since `describeSession`
  already makes the real prompt something no one reads whole.
- **Clause assertions can rot into keyword matching.** Asserting `/nothing needs
  switching/i` tests a phrase, not a policy — the same mistake as item 1, in test
  form. Keeping clauses few, named after the claim rather than the wording, and
  leaving the *behaviour* to the judged tier is what keeps this honest.
- **Indirection for its own sake, if overdone.** A rule stated in exactly one place
  should stay a string in that place. Only rules with two or more renderings, or a
  mechanical consequence in code, earn a module.
- **The judged tier is the flaky one.** `behavior.spec.ts` says so itself and runs
  nightly rather than per-PR. Per-rule scenarios grow the slowest, least reliable
  suite; the deterministic drift test is what runs on every PR.
- **Real work, spread thin.** Ten-odd rules across four files, each needing a
  scenario. The value arrives per rule, which is also the only way it is affordable.

### Alternatives considered

- **Delete the redundancy — state each rule once, in the system prompt only.**
  Cheapest, and wrong: the reinforcement at the tool result is doing work, since it
  arrives at the moment of the decision rather than several thousand tokens earlier.
  Removing it would trade a maintenance problem for a behaviour regression.
- **Number the prompt rules and cross-reference them in comments.** Nearly free, and
  it does make the rules enumerable — but comments are not checked either, so it
  answers the reviewer's question without fixing the drift.
- **One shared paragraph interpolated into all three sites.** Genuinely single-source,
  and it produces bad prose at each site: the standing rule and the "this has already
  happened to you" rule cannot be the same sentence without one of them reading wrong.
- **Judged coverage only, no drift test.** Attractive because it tests behaviour
  rather than wording, but it puts the entire safety net in the flakiest, slowest,
  nightly-only tier. The two belong together: the drift test catches the edit, the
  scenario catches the consequence.

---

## 3. The appointment tools can only address the last booking

**The most serious item here.** The others are maintenance problems. This one silently
performs the wrong irreversible write on a real patient's calendar.

### What exists

`getAppointment` (`lib/tools/appointments.ts:491`) and `cancelAppointment`
(`lib/tools/appointments.ts:516`) both take `inputSchema: z.object({})` and both open
with:

```ts
const latest = session.booked.at(-1);
```

The session carries the full list — `session.booked` is an array, appended on every
confirm (`appointments.ts:466`), each entry holding `id`, `service`, `startsAtUtc`,
`provider`, `price`, `holdId`. And `describeSession` (`lib/session.ts:426`) reads the
whole array into the prompt:

> "Already booked in this conversation: Adult Cleaning on Thursday, July 30, 2026 at
> 9:00 AM MDT with Maria Gonzalez RDH ($0.00 copay); Comprehensive Exam on Tuesday,
> August 4, 2026 at 2:00 PM MDT with Dr Chen ($125.00). Do not book a second
> appointment unless the patient asks for one."

So the agent is *shown* every booking and given *no way to name one*. Book a cleaning,
then an exam, then say "actually, cancel the cleaning":

1. The agent can see both, and will correctly say "sure, cancelling the Adult Cleaning
   on Thursday at 9:00 AM."
2. It calls `cancelAppointment` — there is no argument to pass, so nothing it said
   reaches the tool.
3. `at(-1)` cancels the **exam**.
4. `summarize` returns the exam's details, and the agent relays them as the
   cancellation it just performed.

The patient is told the cleaning is cancelled. The exam is cancelled instead. Both
statements the agent makes are confident and wrong, the write is irreversible, and the
slot it reopened was not the one anyone asked about. This is worse than a refusal and
worse than "it can only cancel the exam" — the failure is invisible to the agent,
invisible to the patient, and invisible to the logs, which record a successful cancel.

`getAppointment` fails the same way more quietly: asked "is my cleaning still on?", it
re-reads the exam and answers about that.

Nothing tests this. `lib/tools/appointments.test.ts` covers paging, refs, holds and the
confirm-retry machinery exhaustively — 40-odd cases — and never constructs a session
with two bookings. Neither does any e2e scenario.

One constraint on the fix, from existing design: **the appointment id must not become a
tool argument.** The comment at `appointments.ts:478` is explicit that the id is logged
and nowhere else, `summarize` deliberately omits it, and the `slotRefs` machinery
(`appointments.ts:100`) exists because the model garbles UUIDs across turns — that bug
surfaced as a 404 on hold relayed to the patient as "there was a problem, can you
confirm your details again". Asking the model to pass an appointment UUID would
reintroduce exactly that failure on the cancel path, where the consequence is worse.

### What would replace it

Booking refs, mirroring the slot-ref pattern that already works.

1. **A ref per booking.** Assign a short stable ref when a booking is pushed onto
   `session.booked` (`B1`, `B2`, … — distinct from slot refs' bare numbers so the two
   can never be confused). It lives on the booked entry, so it survives the round trip
   through `serializeSession`/`persistedSession` (`session.ts:218`) and means the same
   thing on the instance that reads it as on the one that wrote it. The real id still
   never leaves `appointments.ts`.
2. **`describeSession` offers the refs.** The booked line becomes "`B1` — Adult
   Cleaning on Thursday… ; `B2` — Comprehensive Exam on Tuesday…", so the model reads
   the selector in the same breath as the thing it selects.
3. **Both tools take `booking`, required.** `z.object({ booking: z.string().describe(
   'The ref of the appointment, from the booked list') })`. An unknown ref is refused
   the way an unknown slot ref already is (`appointments.ts:368`): name the refs that
   do exist, tell it not to guess.
4. **Refuse rather than assume when the list has more than one entry and the ref is
   missing or unrecognised.** The refusal must carry a disambiguation prompt — the
   refs and their times — and must not read as "you have no appointment". The existing
   no-booking guidance (`appointments.ts:526`, "absence of a record is not evidence of
   absence") is the model for tone here, and the distinction matters: *"I have two on
   file, which one?"* is a fine thing to say to a patient; *"you have nothing booked"*
   is the sentence that already went wrong once.
5. **Single-entry ergonomics.** With exactly one booking, a missing ref may default to
   it — the common case stays one call and there is nothing to get wrong. The
   ambiguity guard only bites when ambiguity actually exists.

### Reschedule, which the same machinery makes honest

Rescheduling is currently emergent: nothing names it, so the agent improvises
cancel-then-rebook. That is the dangerous order. Cancel first and the patient has
given up a real appointment before a replacement exists — if availability comes back
empty, or the hold expires, or the turn hits its deadline mid-flight, they end the
conversation with nothing, having been told they were being moved.

With addressable bookings the safe order is stateable: **find, hold, confirm the new
appointment, and only then cancel the old one by its ref.** A patient briefly holding
two appointments is recoverable by anyone; a patient holding none, who was told
otherwise, is the failure that reaches the front desk. Worth its own guidance on
`cancelAppointment` and a rule in the prompt — and, if this lands after item 2, worth
being a policy module with a scenario rather than another paragraph.

### Pros

- **Removes a class of silent wrong writes.** The agent can no longer act on an
  appointment other than the one it just named.
- **Reuses a pattern that is already proven here.** Slot refs exist for this exact
  reason, are already tested (`appointments.test.ts:109`, `:132`, `:148`), and keep
  UUIDs away from the model.
- **The prompt stops describing something the tools cannot do.** Today
  `describeSession` shows a list the tool layer cannot index — the fix closes that gap
  rather than papering over it.
- **Refusal is a good outcome here.** Asking "which one?" costs a turn; cancelling the
  wrong appointment costs a patient their slot and the practice its credibility.
- **Deterministic and cheaply testable.** Two bookings, cancel `B1`, assert the API was
  called with `B1`'s id and that `B2` survives in `session.booked`. Plus the ambiguity
  refusal, the unknown ref, and the single-booking default. No model needed.
- **Makes reschedule expressible at all**, in an order that cannot strand a patient.

### Cons

- **A new required argument the model can get wrong.** Mitigated by refs being short
  and offered verbatim in the prompt, and by refusing unknown refs rather than falling
  back — but a model that passes `B2` when it meant `B1` still cancels the wrong thing.
  The ref narrows the failure to a transcription error; it does not eliminate it.
  Echoing the service and time back in the tool result, so the agent's confirmation
  sentence is built from what was actually cancelled rather than from what it intended,
  is the cheap second line of defence and worth doing.
- **Ref stability across persistence.** Refs must be assigned once and persisted, not
  derived from array position — a session restored on another instance that renumbers
  would silently re-point `B1` at a different appointment, which is the original bug
  wearing a disguise. This is the part to get right, and `slotRefs`' "a slot keeps the
  ref it was first given" (`appointments.ts:269`) already establishes the rule.
- **Touches the persisted session shape.** `persistedSession` gains a field; it must be
  optional so runs written before it still restore, exactly as `holdId` was
  (`session.ts:225`).
- **More turns in the multi-booking case.** Correct, and the point.
- **The reschedule ordering can briefly double-book.** Deliberate, and the lesser harm,
  but it should be stated in the guidance rather than discovered.

### Alternatives considered

- **Pass the appointment id.** The obvious selector, ruled out by existing design: the
  model garbles UUIDs (the reason `slotRefs` exists), and `summarize` withholds the id
  on purpose. Refs give the same addressing without handing the model an identifier it
  cannot copy.
- **Select by time or service instead of a ref** — "cancel the 9:00 AM one". Reads
  naturally and matches how a patient talks, but it needs matching logic that can be
  ambiguous exactly when it matters: two providers can be free at the same instant,
  which is the reason `unresolvedConfirm` already matches on `holdId` rather than start
  time (`session.ts:130`). Same trap, same answer.
- **Keep the empty schema and refuse whenever there is more than one booking.** A
  one-line change that converts the silent wrong write into an honest dead end — the
  agent could then only send the patient to the front desk. Strictly better than today
  and much cheaper, so it is a reasonable stopgap if the full change has to wait, but
  it leaves a two-appointment conversation unable to cancel anything at all.
- **Let the model pass an index into the booked list.** No new field to persist, but an
  index is positional, and the list mutates — `cancelAppointment` filters it
  (`appointments.ts:544`) — so the same number means different appointments before and
  after a cancel. That is the bug again.
