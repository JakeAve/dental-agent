import { z } from 'zod';
import { runAgentOnce } from '@/lib/agent';
import { createClient } from '@/lib/cedar-ridge';
import { agentBudgetMs, waitBudgetMs } from '@/lib/budget';
import { PRACTICE, PROTOCOL_VERSION } from '@/lib/config';
import { sharedStoreFromEnv } from '@/lib/idempotency';
import { errorLabel } from '@/lib/log';
import {
  getRun,
  peekRun,
  publishedRun,
  serializeRun,
  type Turn,
} from '@/lib/run-store';
import { capMessage, collapseRestartedReply } from '@/lib/reply';

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

/**
 * Nothing may leave this route that is not a well-formed turn response.
 *
 * The protocol treats invalid JSON, a mismatched id, an unsupported status, an
 * oversized body and a timeout alike: not as a scheduling failure but as a
 * candidate-endpoint error that ends the whole run. An unhandled exception here
 * would be answered by the framework with a 500 and an HTML-ish body, throwing
 * away every turn that had already gone well — so the handler is wrapped, and
 * the wrapper answers with the same apology the patient would have got from a
 * failed turn.
 */
export async function POST(req: Request) {
  // Filled in as soon as they are known, so the last resort can still echo the
  // ids the protocol requires.
  const echo: { runId?: string; turnId?: string; version?: string } = {};

  try {
    return await handleTurn(req, echo);
  } catch (err) {
    console.error(
      `[evaluation-turn] run=${echo.runId ?? '?'} turn=${echo.turnId ?? '?'} ` +
        'unhandled failure:',
      errorLabel(err),
    );

    // Before the ids are known there is no well-formed response to give, and a
    // JSON 500 is the honest answer. After, the turn can still be answered.
    return echo.runId && echo.turnId
      ? reply(
          envelope(echo.version, echo.runId, echo.turnId, {
            message: FALLBACK,
            status: 'continue',
          }),
        )
      : reply({ error: 'internal error' }, 500);
  }
}

async function handleTurn(
  req: Request,
  echo: { runId?: string; turnId?: string; version?: string },
) {
  /**
   * One clock for the whole request, started before anything else happens.
   *
   * The protocol's twenty seconds are counted from when the evaluator sends,
   * not from when the model starts, and everything between the two costs real
   * time: parsing, three shared-store round trips, then two writes on the way
   * out. Timing only the agent is how a request that looks well inside budget
   * exceeds it — and a timeout is not a lost turn, it ends the whole run as an
   * endpoint failure.
   */
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

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

  echo.runId = run_id;
  echo.turnId = turn_id;
  echo.version = protocol_version;

  // Idempotency, in layers, cheapest first: a turn this process already
  // answered replays verbatim, and a retry that races the original awaits it
  // instead of acting twice.
  const local = peekRun(run_id);
  if (local) {
    const done = local.turns.get(turn_id);
    if (done) return reply(envelope(protocol_version, run_id, turn_id, done));

    const racing = local.inFlight.get(turn_id);
    if (racing) {
      // Caught, not awaited bare: `work` rejects on both the deadline and the
      // crash path, and letting that propagate would answer a retry with a 500
      // — an endpoint error that ends the run, when the original attempt is
      // meanwhile handling its own failure properly.
      const raced = await racing.catch(() => null);
      return reply(
        envelope(
          protocol_version,
          run_id,
          turn_id,
          raced ?? { message: FALLBACK, status: 'continue' },
        ),
      );
    }
  }

  // Then across instances: the maps above are per-process, and Vercel routes
  // retries wherever it likes — a replay landing on a fresh instance would sail
  // past both and act twice. With Redis configured, exactly one instance claims
  // each turn; the rest replay its saved result or wait for it.
  const shared = sharedStoreFromEnv();
  if (shared) {
    const settled = await shared.getTurn(run_id, turn_id);
    if (settled) {
      // Cached here only if this process already holds the run. Building one
      // just to hold a replayed turn would shadow the fuller state the next
      // turn restores from the shared store; caching into a run we already have
      // is what keeps a third retry answerable if Redis goes down in between,
      // since every method there fails open and a failed-open claim is granted.
      local?.turns.set(turn_id, settled);
      return reply(envelope(protocol_version, run_id, turn_id, settled));
    }

    if (!(await shared.claimTurn(run_id, turn_id))) {
      // Another instance is executing this turn right now.
      // Bounded by what is left of the request, not by a fixed wait: this
      // instance has already spent time getting here, and the winner's answer
      // is worthless if we hand it over after the evaluator has given up.
      const won = await shared.awaitTurn(run_id, turn_id, waitBudgetMs(elapsed()));
      if (won) local?.turns.set(turn_id, won);
      return reply(
        envelope(
          protocol_version,
          run_id,
          turn_id,
          won ?? { message: FALLBACK, status: 'continue' },
        ),
      );
    }
  }

  // This instance owns the turn. Materialise the run against the shared store —
  // asked for even when this process already holds the run, because holding a
  // run is not the same as holding the latest one. Instances stay warm, so turn
  // 4 can land back on the instance that served turn 1 and has never heard
  // about the hold taken on turn 3. Visible history cannot cover the gap: it
  // carries neither the patient id nor the slots, and an agent that cannot see
  // its own patient record registers a second one.
  const run = getRun(
    run_id,
    input.history,
    shared ? await shared.loadRun(run_id) : undefined,
  );

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

  // Whatever the request has left once the writes still to come are set aside.
  const agentBudget = agentBudgetMs(elapsed());
  const deadline = setTimeout(() => control.abort(), agentBudget);

  const work = (async (): Promise<Turn> => {
    // Built beside the run rather than pushed into it. A turn that fails must
    // leave `run.messages` exactly as it found it: appending the patient's line
    // up front means a retry of a failed turn appends it a second time, and the
    // model then answers a question it can see asked twice.
    const patientSaid = { role: 'user' as const, content: input.message };
    const messages = [...run.messages, patientSaid];

    const result = await runAgentOnce({
      messages,
      client: createClient({
        baseUrl: base_url,
        apiKey: api_key,
        signal: control.signal,
      }),
      session: run.session,
      abortSignal: control.signal,
    });

    // Committed only now that the turn has produced something: the full step
    // history, tool calls and results included, so later turns keep the
    // patientId and the slots we already paid to fetch.
    //
    // Appended to whatever the run holds *now*, not to the snapshot taken
    // above. Writing the snapshot back would make this a read-modify-write: two
    // attempts overlapping on one run — the premise of every retry path here —
    // would both start from the same base, and the one that finished second
    // would erase the other's turn entirely.
    run.messages = [...run.messages, patientSaid, ...result.response.messages];

    // Tool names only — never arguments, which carry patient data and could
    // carry the key. Without this it is impossible to tell a real booking from
    // a model that only claimed to make one.
    const called = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
    console.log(
      `[evaluation-turn] run=${run_id} turn=${turn_id} tools=[${called.join(', ')}]`,
    );

    let message = collapseRestartedReply(result.text.trim());
    if (message !== result.text.trim()) {
      console.warn(
        `[evaluation-turn] run=${run_id} turn=${turn_id} collapsed a restarted reply`,
      );
    }
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
    // Publish before responding, so a retry that races the response cannot
    // land on another instance ahead of the saved turn. The claim lock stays:
    // releasing it here would let a late retry claim and re-run a finished turn.
    //
    // Run state first, deliberately. If the process dies between these two
    // writes, a saved run without a saved turn means a retry re-runs the turn
    // already knowing what it did — which describeSession turns into "do not
    // book a second appointment". The reverse order would leave the next turn
    // restoring a run that has forgotten this turn's patient id.
    if (shared) {
      const published = serializeRun(run);
      if (await shared.saveRun(run_id, published)) publishedRun(run, published);
      await shared.saveTurn(run_id, turn_id, turn);
    }
  } catch (err) {
    // No error detail in the response, and none in the log either: the key
    // travels in this request, and neither a leaked message nor a leaked log
    // line is worth the diagnosis. See lib/log.ts.
    console.error(
      `[evaluation-turn] run=${run_id} turn=${turn_id} ` +
        `${control.signal.aborted ? `exceeded ${agentBudget}ms` : 'failed'}:`,
      errorLabel(err),
    );
    turn = { message: FALLBACK, status: 'continue' };

    // The fallback is deliberately not saved as this turn's answer: a retry of
    // a timed-out turn deserves a real attempt rather than a permanent apology,
    // so the claim is freed and the turn may run again on whichever instance it
    // lands.
    //
    // What must not happen is that second attempt acting as though the first
    // never touched anything. A deadline can fire after confirmAppointment
    // returned — the booking exists, the patient just never heard about it —
    // and the tools mutate the session as they go, so the session is the record
    // of what actually happened. Publishing it before releasing the claim is
    // what makes the retry idempotent: it opens with "already booked in this
    // conversation" instead of booking a second appointment. Order matters, and
    // it costs one round trip on a path that has already given up on speed.
    if (shared) {
      const published = serializeRun(run);
      if (await shared.saveRun(run_id, published)) publishedRun(run, published);
      await shared.releaseTurn(run_id, turn_id);
    }
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
    // Capped here, at the one place every answer passes through, rather than
    // at each of the places one is produced.
    output: { message: capMessage(turn.message) },
    status: turn.status,
  };
}
