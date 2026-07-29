# Dental scheduling agent

A scheduling agent for Cedar Ridge Family Dental, built for the Podium exercise.
It talks to a synthetic patient over the `candidate-agent/1` HTTP turn protocol
and does the actual work against the Cedar Ridge Scheduling API: identifies or
registers the patient, settles insurance, searches slots, holds one, and books
it — reading API error responses to recover, and asking the patient only for what
it still needs.

- **Evaluation endpoint:** `POST /api/evaluation-turn` — the protocol handler.
  See `public/agent.md`, served at `/agent.md`, for what it guarantees.
- **Chat UI:** `/` — the same agent with a browser front end and an inspector
  showing the state the tools established, for testing by hand.

## Running it

```bash
npm install
npm run dev
```

`.env` needs:

| Variable | For |
| --- | --- |
| `OPENAI_API_KEY` | the model |
| `CEDAR_RIDGE_BASE_URL`, `CEDAR_RIDGE_API_KEY` | the scheduling sandbox, for the chat UI and the tests |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis, for cross-instance run state and turn idempotency |

The evaluation endpoint takes its scheduling credentials from each request
instead, because they are run-scoped and expire; it never reads them from the
environment. Redis is optional — without it the agent degrades to per-process
state, which is correct on one instance and not on several.

`AGENT_BEARER_TOKEN`, if set, is required as `Authorization: Bearer <token>` on
the evaluation endpoint.

## Tests

```bash
npm run test:unit    # pure logic, no network, milliseconds
npm run e2e:smoke    # protocol conformance, books nothing
npm run e2e:core     # conformance plus the two booking outcomes
npm run e2e:full     # everything, including model-judged scenarios
npm run e2e:cleanup  # cancel anything a crashed run left behind
```

The e2e suite drives the real agent over HTTP against the real sandbox, through
a recording proxy that captures the API calls, caps how many appointments a
scenario may create, and injects the failures the sandbox will not produce on
cue. It is serial on purpose: the sandbox is shared and stateful, and a patient
may hold only one slot at a time. Anything it books, it cancels.

`test-scenarios.md` is the scenario plan the specs are drawn from.

## Where things are

| Path | What lives there |
| --- | --- |
| `app/api/evaluation-turn/` | the protocol handler: idempotency, budgets, response shape |
| `lib/agent.ts` | the tool-use loop and the system prompt |
| `lib/tools/` | one file per group of tools, plus the API error recovery table |
| `lib/session.ts` | what the agent has established, as code rather than as memory |
| `lib/run-store.ts`, `lib/idempotency.ts` | run state and turn idempotency, per-process and shared |
| `lib/cedar-ridge.ts` | the scheduling API client |
| `lib/config.ts` | every tunable, in one place |

`AGENTS.md` is for whoever works on this next, human or otherwise.
