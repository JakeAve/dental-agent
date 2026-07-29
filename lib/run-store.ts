import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { MAX_RUNS, RUN_TTL_MS } from './config';
import {
  createSession,
  deserializeSession,
  serializeSession,
  type PersistedSession,
  type Session,
} from './session';

/**
 * Conversation state for the evaluation protocol, keyed by `run_id`.
 *
 * The protocol allows reconstructing state from `input.history`, but history
 * only carries the *visible* turns — the patient's words and ours. Everything
 * the agent learned by calling the API (the patientId, which slots it offered,
 * what insurance came back as) lives in tool messages that history does not
 * include. Keeping the real message list means turn 4 still knows the patientId
 * from turn 2 without paying to look it up again.
 *
 * History is still honoured as a fallback: if a run arrives that this process
 * has never seen — a restart, or a second instance behind a load balancer — the
 * conversation is rebuilt from it rather than starting blank.
 *
 * The maps below are per-process, which is not enough on Vercel: the evaluator's
 * turn 4 can land on an instance that never saw turns 1–3. So a run is also
 * written to the shared store after every turn and restored here on a local
 * miss — see `serializeRun`/`deserializeRun` and lib/idempotency.ts. History
 * remains the last resort, for when no shared store is configured at all.
 */

export type Turn = {
  message: string;
  status: 'continue' | 'complete';
};

type Run = {
  session: Session;
  messages: ModelMessage[];
  /** Completed turns, so a transport retry replays instead of re-acting. */
  turns: Map<string, Turn>;
  /** Turns still running, so a retry that races the original waits for it. */
  inFlight: Map<string, Promise<Turn>>;
  lastTouched: number;
};

const runs = new Map<string, Run>();

function evict(now: number) {
  for (const [id, run] of runs) {
    if (now - run.lastTouched > RUN_TTL_MS) runs.delete(id);
  }

  // Hard cap as a backstop, oldest first.
  if (runs.size > MAX_RUNS) {
    const ordered = [...runs.entries()].sort(
      (a, b) => a[1].lastTouched - b[1].lastTouched,
    );
    for (const [id] of ordered.slice(0, runs.size - MAX_RUNS)) runs.delete(id);
  }
}

/** The run this process already has, without creating one. */
export function peekRun(runId: string): Run | undefined {
  const run = runs.get(runId);
  if (run) run.lastTouched = Date.now();
  return run;
}

/**
 * Fetch the run, creating it if this process has not seen it.
 *
 * Three sources, in descending fidelity: state this process already holds, then
 * `restore` from the shared store, then the visible `history`. Only the first
 * two carry what the agent learned from the API.
 */
export function getRun(
  runId: string,
  history: Array<{ role: 'patient' | 'agent'; content: string }>,
  restore?: unknown,
): Run {
  const now = Date.now();
  evict(now);

  let run = runs.get(runId);

  if (!run) {
    const restored = restore === undefined ? null : deserializeRun(restore);

    run = {
      session: restored?.session ?? createSession(),
      messages:
        restored?.messages ??
        history.map((h) => ({
          role: h.role === 'patient' ? ('user' as const) : ('assistant' as const),
          content: h.content,
        })),
      turns: new Map(),
      inFlight: new Map(),
      lastTouched: now,
    };
    runs.set(runId, run);
  }

  run.lastTouched = now;
  return run;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * What travels to the shared store: the tool-derived session, and the real
 * message list including tool calls and their results.
 *
 * `turns` and `inFlight` deliberately do not. Completed turns are already
 * published individually (a retry replays one turn, not the whole run), and an
 * in-flight promise cannot leave the process it is running in.
 */
export type PersistedRun = {
  session: PersistedSession;
  messages: ModelMessage[];
};

export function serializeRun(run: Run): PersistedRun {
  return { session: serializeSession(run.session), messages: run.messages };
}

/**
 * Messages are checked for shape but not for type.
 *
 * `ModelMessage` is a wide union whose parts the AI SDK owns; re-declaring it
 * here as a schema would go stale on the next upgrade and reject valid state.
 * What matters is that the array is an array of role-bearing objects — enough
 * that a corrupt or foreign value is rejected rather than handed to the model.
 */
const persistedRun = z.object({
  session: z.unknown(),
  messages: z.array(z.object({ role: z.string() }).passthrough()),
});

export function deserializeRun(
  raw: unknown,
): { session: Session; messages: ModelMessage[] } | null {
  const parsed = persistedRun.safeParse(raw);
  if (!parsed.success) return null;

  const session = deserializeSession(parsed.data.session);
  if (!session) return null;

  return { session, messages: parsed.data.messages as ModelMessage[] };
}

/** Test seam — the protocol route has no other way to reset process state. */
export function clearRuns() {
  runs.clear();
}
