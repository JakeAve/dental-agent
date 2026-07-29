import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * A crash-durable record of everything the tests created in the sandbox.
 *
 * The sandbox is persistent and there is NO endpoint that lists appointments —
 * `GET /appointments/{id}` needs an id you already hold. So an appointment whose
 * id is only in memory when the process dies is unreachable forever, and it
 * occupies a real slot that no later run can book.
 *
 * Hence: ids are appended to disk the instant they are observed, before the
 * test that caused them finishes. Normal teardown cancels and marks them
 * released; anything left over is swept by `npm run e2e:cleanup`.
 */

export const LEDGER_PATH = join(process.cwd(), 'e2e', '.artifacts', 'created.jsonl');

export type LedgerEntry = {
  kind: 'appointment' | 'patient';
  id: string;
  scenario: string;
  createdAt: string;
  releasedAt?: string;
};

function ensureDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Append-only, synchronous, flushed immediately — this must survive a SIGKILL. */
export function record(entry: Omit<LedgerEntry, 'createdAt'>) {
  ensureDir(LEDGER_PATH);
  appendFileSync(
    LEDGER_PATH,
    JSON.stringify({ ...entry, createdAt: new Date().toISOString() }) + '\n',
    'utf8',
  );
}

export function readLedger(): LedgerEntry[] {
  if (!existsSync(LEDGER_PATH)) return [];

  return readFileSync(LEDGER_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

/**
 * Mark ids as released by rewriting the file. Cancellation is idempotent on the
 * API side, so a crash between the DELETE and this write only costs a redundant
 * DELETE on the next sweep — never a missed cleanup.
 */
export function markReleased(ids: Set<string>) {
  const entries = readLedger();
  if (entries.length === 0) return;

  const now = new Date().toISOString();
  const updated = entries.map((e) =>
    ids.has(e.id) && !e.releasedAt ? { ...e, releasedAt: now } : e,
  );

  ensureDir(LEDGER_PATH);
  writeFileSync(LEDGER_PATH, updated.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

export const outstandingAppointments = (): LedgerEntry[] =>
  readLedger().filter((e) => e.kind === 'appointment' && !e.releasedAt);
