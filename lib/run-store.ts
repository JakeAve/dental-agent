import type { ModelMessage } from 'ai';
import { MAX_RUNS, RUN_TTL_MS } from './config';
import { createSession, type Session } from './session';

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
 * In-memory is the right call for a single evaluated process. Multiple
 * instances would need this in Redis; the interface would not change.
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

/**
 * Fetch the run, creating it from `history` if this process has not seen it.
 */
export function getRun(
  runId: string,
  history: Array<{ role: 'patient' | 'agent'; content: string }>,
): Run {
  const now = Date.now();
  evict(now);

  let run = runs.get(runId);

  if (!run) {
    run = {
      session: createSession(),
      messages: history.map((h) => ({
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

/** Test seam — the protocol route has no other way to reset process state. */
export function clearRuns() {
  runs.clear();
}
