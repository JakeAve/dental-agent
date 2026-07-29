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

const turnSchema = z.object({
  message: z.string().min(1),
  status: z.enum(['continue', 'complete']),
});

/**
 * A turn read back from the shared store, or null if it is not one.
 *
 * A replayed turn is answered verbatim, so it reaches the evaluator without
 * passing any of the code that produced the original. The protocol treats an
 * empty message and an unsupported status the same way it treats a timeout —
 * the run ends as an endpoint error — so a stored value that is not a turn must
 * read as a miss and be executed afresh, not forwarded.
 */
export function parseTurn(raw: unknown): Turn | null {
  const parsed = turnSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type Run = {
  session: Session;
  messages: ModelMessage[];
  /**
   * How many times this copy has been published.
   *
   * The ordering that matters is the message count, which is intrinsic — see
   * `versionOf`. This is only the tie-break beneath it, for a publish that
   * changes the session without adding a message: a turn killed after its
   * booking landed has exactly the same messages as before and a session that
   * must not be lost.
   */
  rev: number;
  /** Completed turns, so a transport retry replays instead of re-acting. */
  turns: Map<string, Turn>;
  /** Turns still running, so a retry that races the original waits for it. */
  inFlight: Map<string, Promise<Turn>>;
  lastTouched: number;
};

const runs = new Map<string, Run>();

/**
 * A run with work in flight is never evicted, whatever its age or the cap.
 *
 * Dropping one loses the promise a racing retry would have waited on, and the
 * retry then builds a fresh run and executes a turn that is already running —
 * two bookings from one turn_id, caused by a memory backstop.
 */
const busy = (run: Run) => run.inFlight.size > 0;

function evict(now: number) {
  for (const [id, run] of runs) {
    if (now - run.lastTouched > RUN_TTL_MS && !busy(run)) runs.delete(id);
  }

  // Hard cap as a backstop, oldest first.
  if (runs.size > MAX_RUNS) {
    const ordered = [...runs.entries()]
      .filter(([, run]) => !busy(run))
      .sort((a, b) => a[1].lastTouched - b[1].lastTouched);
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
      rev: restored?.rev ?? 0,
      turns: new Map(),
      inFlight: new Map(),
      lastTouched: now,
    };
    runs.set(runId, run);
  } else if (restored && shouldAdopt(restored, run)) {
    // Another instance has taken this run further. Adopt its state in place —
    // the Run object itself must survive, because the in-flight and completed
    // turn maps hanging off it are this process's own idempotency record.
    run.session = restored.session;
    run.messages = restored.messages;
    run.rev = restored.rev;
  }

  run.lastTouched = now;
  return run;
}

/**
 * A copy's place in the order: how much conversation it has absorbed, then how
 * many times it has been published.
 *
 * The message count leads because it is intrinsic — it *is* the content, so it
 * cannot drift from it. A counter kept alongside the state can: a write whose
 * confirmation timed out yet landed leaves an instance holding newer state at an
 * older number, after which ordering by that number alone hands it back its own
 * earlier copy and it forgets a patient it registered.
 *
 * Messages are only ever appended, never removed, so the count is monotonic per
 * run and comparable between instances — where a count of *turns* would not be,
 * since each instance sees a different subset of them. `rev` breaks the tie for
 * a publish that changed the session without adding a message.
 */
const versionOf = (copy: { messages: ModelMessage[]; rev: number }) => ({
  seq: copy.messages.length,
  rev: copy.rev,
});

function shouldAdopt(
  restored: { session: Session; messages: ModelMessage[]; rev: number },
  run: Run,
): boolean {
  // A run rebuilt from visible history knows no patient, and nothing about the
  // ordering can express how much that costs: booking against it registers the
  // same person a second time, in a system the evaluator reads directly. So a
  // stored copy that knows who the patient is always wins over one that does
  // not, whatever the counts say.
  if (restored.session.patient && !run.session.patient) return true;

  const theirs = versionOf(restored);
  const ours = versionOf(run);

  return (
    theirs.seq > ours.seq || (theirs.seq === ours.seq && theirs.rev > ours.rev)
  );
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
  /** Message count, carried so the compare-and-set can read it without parsing. */
  seq: number;
  rev: number;
};

/**
 * The run, ready to publish, one revision on.
 *
 * `seq` is not invented here — it is the message count, which this copy already
 * has. Only `rev` moves, and only far enough to outrank the copy we last saw.
 */
export function serializeRun(run: Run): PersistedRun {
  return {
    session: serializeSession(run.session),
    messages: run.messages,
    seq: run.messages.length,
    rev: run.rev + 1,
  };
}

/**
 * Records that a published revision is now this run's own.
 *
 * Only on a write that landed. Claiming a revision that was refused would make
 * this instance outrank the copy that beat it, and it would then decline to
 * adopt that copy — the divergence would be permanent rather than one turn long.
 */
export function publishedRun(run: Run, published: PersistedRun) {
  run.rev = Math.max(run.rev, published.rev);
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
  // Both optional so a run written by an earlier deployment still restores. The
  // message count is read from the messages themselves, so a missing `seq`
  // costs nothing; a missing `rev` reads as the oldest possible revision.
  seq: z.number().optional(),
  rev: z.number().optional(),
});

export function deserializeRun(
  raw: unknown,
): { session: Session; messages: ModelMessage[]; rev: number } | null {
  const parsed = persistedRun.safeParse(raw);
  if (!parsed.success) return null;

  const session = deserializeSession(parsed.data.session);
  if (!session) return null;

  return {
    session,
    messages: parsed.data.messages as ModelMessage[],
    rev: parsed.data.rev ?? 0,
  };
}

/** Test seam — the protocol route has no other way to reset process state. */
export function clearRuns() {
  runs.clear();
}
