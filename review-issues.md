# Review issues

Review performed July 29, 2026. This is a read-only assessment of the agent,
its specifications, tests, and the public candidate guide/API docs. No secrets
are included here.

## High priority

### 1. `not_accepted` insurance wrongly blocks availability

`insuranceBlocks` treats `not_accepted` as a blocking state. The API contract
and the test scenarios state that an out-of-network plan may proceed at the
self-pay price. The current behavior requires a second explicit conversion to
`self_pay`, which can strand a patient after their plan is declined.

- Location: `lib/session.ts` (`insuranceBlocks`)
- Affected path: `findAvailability` in `lib/tools/appointments.ts`
- Suggested resolution: permit availability for `not_accepted`, and ensure the
  patient is told the visit will be charged at the self-pay price.

### 2. Availability pagination is not implemented

The Cedar Ridge client accepts a `page` query parameter, but `findAvailability`
does not expose or use it. It reports `morePages` without being able to fetch
the next page. The agent can therefore miss valid appointments and cannot meet
the specification requirement to check later pages before concluding that no
suitable appointment exists.

- Location: `lib/tools/appointments.ts` (`findAvailability`)
- Suggested resolution: add page-aware retrieval, or automatically aggregate
  pages within a bounded call budget; keep offered slot references stable across
  the aggregated results.

### 3. The user interface promises unsupported capabilities

The chat UI says it can reschedule appointments, cancel appointments, answer
account questions, and check balances. The agent cannot reschedule, has no
balance capability, and can only cancel an appointment booked in the current
in-memory conversation. It cannot find a pre-existing appointment.

- Location: `app/page.tsx`
- Related limitation: `lib/tools/appointments.ts`
- Suggested resolution: either implement these capabilities (within API
  constraints) or change the UI and system prompt to advertise only supported
  actions.

### 4. Hosted evaluation state and idempotency are process-local

`run-store.ts` keeps run state, completed turns, and in-flight turns in memory.
A restart or request routed to a different instance loses tool-derived state
and idempotent replay protection. Reconstructing the visible conversation
history cannot recover patient IDs, held slots, or prior tool results.

- Location: `lib/run-store.ts`
- Suggested resolution: for a multi-instance or production deployment, persist
  run state and turn results in a shared store with an atomic idempotency key.
  A single-process evaluator can retain the current simpler implementation.

### 5. The browser chat route has no request validation or patient-safe error handling

`/api/chat` destructures arbitrary request JSON and allows unexpected errors
from message conversion, the model, or tools to become generic server errors.

- Location: `app/api/chat/route.ts`
- Suggested resolution: validate the request schema and return a controlled,
  non-sensitive fallback message for operational failures.

## Test coverage gaps

The written scenario plan is strong: it is specific about API ordering,
insurance state, pricing, time zones, hold conflicts, safety, and adversarial
requests. The executable suite is currently much narrower:

- Two booking outcome tests.
- Protocol conformance tests.
- Three model-judged behavior scenarios.

Prioritize deterministic end-to-end tests for:

1. `not_accepted` insurance and self-pay pricing.
2. Pagination and widening an availability window.
3. Hold expiry, slot contention, and confirm-time conflicts.
4. Cancellation/rescheduling behavior, or explicit unsupported responses.
5. FAQ-grounded policy answers.
6. Invalid patient fields, payer resolution, and invalid member IDs.

The model-judged tests are useful as a supplementary signal, but important
requirements should also have deterministic assertions against API calls and
resulting appointments.

## Verification notes

- `npm run lint` passed.
- `npm run build` passed when Next.js could retrieve its configured Google
  Fonts. The initial sandbox-only build could not access Google Fonts.
- The public candidate guide and Swagger documentation were reachable and
  matched the project’s intended API contract.
- `npm run e2e:smoke` was not completed because an existing local Next dev
  server was already listening on port 3000. That process was left untouched.
