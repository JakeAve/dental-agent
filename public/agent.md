# Dental Scheduling Agent — Evaluation Endpoint

This deployment hosts a candidate agent for the Podium dental scheduling
exercise. It implements the `candidate-agent/1` HTTP turn protocol described at
`<BASE_URL>/agent-protocol.md`.

## Endpoint

```
POST https://dental-agent-two.vercel.app/api/evaluation-turn
Content-Type: application/json
```

- Accepts a `candidate-agent/1` turn request (patient message, visible
  history, and run-scoped `dental_api` resources) and returns the agent's next
  message as JSON.
- Echoes `protocol_version`, `run_id`, and `turn_id` exactly.
- Responds within the 20-second protocol deadline; an internal turn deadline
  aborts agent work (including in-flight scheduling API calls) before the
  evaluator times out, and the patient receives a graceful fallback message.
- `(run_id, turn_id)` is idempotent: a replayed turn returns the original
  response verbatim, and a retry that races the original awaits it rather than
  acting twice — no duplicate bookings.
- Conversation state is kept per `run_id`, including tool-call history, so
  patient identity and previously fetched slots persist across turns.
- The supplied Scheduling API key is used only for that turn's API calls; it is
  never logged, stored, or returned.
- Never redirects; responses stay well under 256 KiB.

## Authentication (optional)

If a shared secret is configured for the deployment (`AGENT_BEARER_TOKEN`),
requests must include:

```
Authorization: Bearer <token>
```

Without a configured token, the endpoint accepts unauthenticated requests.

## Example

```bash
curl -s https://dental-agent-two.vercel.app/api/evaluation-turn \
  -H 'Content-Type: application/json' \
  -d '{
    "protocol_version": "candidate-agent/1",
    "run_id": "demo-run-1",
    "turn_id": "demo-turn-1",
    "turn_number": 1,
    "input": {
      "message": "I am overdue for a cleaning and mornings are best.",
      "history": []
    },
    "resources": {
      "dental_api": {
        "base_url": "https://<scheduling-api-base-url>",
        "api_key": "cand_<run_scoped_key>",
        "docs_url": "https://<scheduling-api-base-url>/docs.md"
      }
    }
  }'
```

## How it works

The agent is an LLM tool-use loop over the Scheduling API: it identifies or
creates the patient, verifies insurance or self-pay, searches offices,
services, and slots, then holds and books an appointment — reading API error
responses to recover and asking the patient only for what it still needs. It
reports `status: "complete"` only once a booking (or other real outcome) exists
and no question is pending, and it keeps run state available for follow-up
turns after completion.

There is also a human-facing chat UI at the deployment root for manual testing.
