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
  /**
   * How many turns of state this copy has absorbed.
   *
   * Instances stay warm, so "this process already has the run" does not mean
   * "this process has the latest run": A can serve turn 1, B serve turns 2 and
   * 3, and then A get turn 4 still holding what it knew after turn 1. Without a
   * version there is no way to notice — A would answer from a session with no
   * hold and no booking, and then publish that over B's. Monotonic per run, and
   * compared, never trusted as a count of anything.
   */
  seq: number;
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
 * Fetch the run, taking whichever copy of its state is furthest along.
 *
 * Three sources, in descending fidelity: `restore` from the shared store and
 * whatever this process already holds, whichever has seen more turns, then the
 * visible `history` if neither exists. Only the first two carry what the agent
 * learned from the API.
 */
export function getRun(
  runId: string,
  history: Array<{ role: 'patient' | 'agent'; content: string }>,
  restore?: unknown,
): Run {
  const now = Date.now();
  evict(now);

  const restored = restore === undefined ? null : deserializeRun(restore);
  let run = runs.get(runId);

  if (!run) {
    run = {
      session: restored?.session ?? createSession(),
      messages:
        restored?.messages ??
        history.map((h) => ({
          role: h.role === 'patient' ? ('user' as const) : ('assistant' as const),
          content: h.content,
        })),
      seq: restored?.seq ?? storedSeq(restore),
      turns: new Map(),
      inFlight: new Map(),
      lastTouched: now,
    };
    runs.set(runId, run);
  } else if (restored && restored.seq > run.seq) {
    // Another instance has taken this run further. Adopt its state in place —
    // the Run object itself must survive, because the in-flight and completed
    // turn maps hanging off it are this process's own idempotency record.
    run.session = restored.session;
    run.messages = restored.messages;
    run.seq = restored.seq;
  } else if (!restored) {
    // Something may be stored that this build cannot read — a schema change
    // across a deployment looks exactly like this. The state is lost either
    // way, but the version is still worth honouring so that what we publish
    // next sorts after it instead of looking older than it is.
    run.seq = Math.max(run.seq, storedSeq(restore));
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
  seq: number;
};

/**
 * The run, one version further along, ready to publish.
 *
 * The bump happens here rather than at the call site so that publishing and
 * versioning cannot drift apart: a copy written without advancing its version
 * would be adopted by nobody, and a version advanced without a write would make
 * this instance look fresher than the state it actually holds.
 */
export function serializeRun(run: Run): PersistedRun {
  run.seq += 1;
  return {
    session: serializeSession(run.session),
    messages: run.messages,
    seq: run.seq,
  };
}

/** A stored run's version, when nothing else about it can be trusted. */
function storedSeq(raw: unknown): number {
  const seq = (raw as { seq?: unknown } | null | undefined)?.seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0;
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
  // Optional so that a run written by the deployment before versioning existed
  // still restores, as the oldest possible version.
  seq: z.number().optional(),
});

export function deserializeRun(
  raw: unknown,
): { session: Session; messages: ModelMessage[]; seq: number } | null {
  const parsed = persistedRun.safeParse(raw);
  if (!parsed.success) return null;

  const session = deserializeSession(parsed.data.session);
  if (!session) return null;

  return {
    session,
    messages: parsed.data.messages as ModelMessage[],
    seq: parsed.data.seq ?? 0,
  };
}

/** Test seam — the protocol route has no other way to reset process state. */
export function clearRuns() {
  runs.clear();
}
