import { z } from 'zod';
import { runAgentOnce } from '@/lib/agent';
import { createClient } from '@/lib/cedar-ridge';
import { PRACTICE, PROTOCOL_VERSION, TURN_DEADLINE_MS } from '@/lib/config';
import { getRun, type Turn } from '@/lib/run-store';

/**
 * The candidate-agent/1 endpoint the evaluator's synthetic patient talks to.
 *
 * Contract (from /agent-protocol.md):
 *   - JSON in, JSON out, inside 20 seconds, under 256 KiB, no redirects.
 *   - Echo protocol_version, run_id and turn_id exactly.
 *   - (run_id, turn_id) is idempotent: a transport retry must not book twice.
 *   - Credentials arrive per request and are revoked before scoring, so nothing
 *     here reads them from the environment.
 *   - Never log or return the supplied scheduling key.
 */

// Literal, not a config import: Next statically analyses segment config and
// rejects anything it cannot evaluate at build time.
export const maxDuration = 30;
// Never prerender or cache: every request is a distinct conversational turn.
export const dynamic = 'force-dynamic';

const turnRequest = z.object({
  protocol_version: z.string().optional(),
  run_id: z.string().min(1),
  turn_id: z.string().min(1),
  turn_number: z.number().optional(),
  input: z.object({
    message: z.string(),
    history: z
      .array(
        z.object({
          role: z.enum(['patient', 'agent']),
          content: z.string(),
        }),
      )
      .default([]),
  }),
  resources: z.object({
    dental_api: z.object({
      base_url: z.string(),
      api_key: z.string(),
      docs_url: z.string().optional(),
    }),
  }),
});

/**
 * Said when the agent cannot answer — a crash, or the deadline. It has to be a
 * real sentence: the synthetic patient reads it, and an empty message is a
 * protocol violation rather than a scheduling failure.
 */
const FALLBACK =
  "I'm sorry — I'm having trouble reaching our scheduling system right now. " +
  `Please give the office a call at ${PRACTICE.phone} and they can get you booked.`;

/**
 * Said when the model returns an empty completion — no text, no tool calls.
 *
 * Not the same situation as FALLBACK, and it must not borrow its words: nothing
 * has failed, so telling the patient the system is down is a lie that ends the
 * conversation. gpt-5.4-mini does this occasionally mid-conversation; a neutral
 * prompt keeps the turn alive and costs nothing when it was a blip.
 */
const EMPTY_REPLY =
  "Sorry, I didn't catch that — could you say it again?";

function reply(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function POST(req: Request) {
  // Optional shared secret, if the interviewer configures one.
  const expected = process.env.AGENT_BEARER_TOKEN;
  if (expected && req.headers.get('authorization') !== `Bearer ${expected}`) {
    return reply({ error: 'unauthorized' }, 401);
  }

  let parsed;
  try {
    parsed = turnRequest.safeParse(await req.json());
  } catch {
    return reply({ error: 'invalid JSON body' }, 400);
  }

  if (!parsed.success) {
    return reply(
      { error: 'request did not match candidate-agent/1', issues: parsed.error.issues },
      400,
    );
  }

  const { run_id, turn_id, input, resources, protocol_version } = parsed.data;
  const { base_url, api_key } = resources.dental_api;

  const run = getRun(run_id, input.history);

  // Idempotency, in two layers: a turn we already answered replays verbatim,
  // and a retry that races the original awaits it instead of acting twice.
  const done = run.turns.get(turn_id);
  if (done) return reply(envelope(protocol_version, run_id, turn_id, done));

  const racing = run.inFlight.get(turn_id);
  if (racing) {
    return reply(envelope(protocol_version, run_id, turn_id, await racing));
  }

  /**
   * The turn's kill switch.
   *
   * The protocol requires background work to stop when the turn ends, and a
   * plain `Promise.race` does not do that — it resolves the caller while the
   * loop keeps running, still calling the scheduling API on a key with a
   * finite budget. So the deadline aborts rather than merely giving up: the
   * model stops taking steps, and the in-flight request is dropped with it.
   */
  const control = new AbortController();
  const deadline = setTimeout(() => control.abort(), TURN_DEADLINE_MS);

  const work = (async (): Promise<Turn> => {
    run.messages.push({ role: 'user', content: input.message });

    const result = await runAgentOnce({
      messages: run.messages,
      client: createClient({
        baseUrl: base_url,
        apiKey: api_key,
        signal: control.signal,
      }),
      session: run.session,
      abortSignal: control.signal,
    });

    // Feed the full step history — including tool calls and their results —
    // back into the run, so later turns keep the patientId and the slots we
    // already paid to fetch.
    run.messages.push(...result.response.messages);

    // Tool names only — never arguments, which carry patient data and could
    // carry the key. Without this it is impossible to tell a real booking from
    // a model that only claimed to make one.
    const called = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
    console.log(
      `[evaluation-turn] run=${run_id} turn=${turn_id} tools=[${called.join(', ')}]`,
    );

    let message = result.text.trim();
    if (!message) {
      console.warn(
        `[evaluation-turn] run=${run_id} turn=${turn_id} empty completion`,
      );
      message = EMPTY_REPLY;
    }

    return {
      message,
      // The evaluator may still send another turn after `complete`, and
      // completion is not what it scores — so this only claims done once
      // something real happened and we are not waiting on an answer. Any
      // question at all means we are still waiting, including "shall I cancel
      // that?" after a successful booking.
      status:
        run.session.resolved && !message.includes('?') ? 'complete' : 'continue',
    };
  })();

  run.inFlight.set(turn_id, work);

  let turn: Turn;
  try {
    turn = await work;
    run.turns.set(turn_id, turn);
  } catch (err) {
    // Deliberately no error detail in the response: the key travels in this
    // request, and a leaked message is a scored failure.
    console.error(
      `[evaluation-turn] run=${run_id} turn=${turn_id} ` +
        `${control.signal.aborted ? `exceeded ${TURN_DEADLINE_MS}ms` : 'failed'}:`,
      err instanceof Error ? err.message : 'unknown error',
    );
    turn = { message: FALLBACK, status: 'continue' };
    // Not cached — a retry of a timed-out turn deserves a real attempt.
  } finally {
    // Both matter: an un-cleared timer would abort a client that finished in
    // time (harmless here, but it keeps the process alive), and a live entry
    // would strand a later retry awaiting a promise that is already settled.
    clearTimeout(deadline);
    run.inFlight.delete(turn_id);
  }

  return reply(envelope(protocol_version, run_id, turn_id, turn));
}

function envelope(
  protocolVersion: string | undefined,
  runId: string,
  turnId: string,
  turn: Turn,
) {
  return {
    protocol_version: protocolVersion ?? PROTOCOL_VERSION,
    run_id: runId,
    turn_id: turnId,
    output: { message: turn.message },
    status: turn.status,
  };
}
