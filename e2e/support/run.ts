import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '../../lib/cedar-ridge';
import { markReleased } from './ledger';
import { openingMessage, replyTo, type Exchange } from './patient';
import type { Persona } from './personas';
import { startProxy, type RecordedCall } from './proxy';
import { sendTurn } from './protocol';

export const AGENT_URL =
  process.env.E2E_AGENT_URL ?? 'http://127.0.0.1:3000/api/evaluation-turn';

export function apiConfig() {
  const baseUrl = process.env.CEDAR_RIDGE_BASE_URL;
  const apiKey = process.env.CEDAR_RIDGE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      'CEDAR_RIDGE_BASE_URL and CEDAR_RIDGE_API_KEY must be set — run via `npm run e2e`.',
    );
  }

  return { baseUrl, apiKey };
}

export type RunResult = {
  persona: Persona;
  runId: string;
  transcript: Exchange[];
  /** Every call the agent made to the dental API, via the proxy. */
  calls: RecordedCall[];
  /** Ids of appointments actually created. Ground truth, not narration. */
  appointmentIds: string[];
  /** Bookings the proxy's circuit breaker refused. Should always be 0. */
  refusedBookings: number;
  /** Convenience: did the agent hit this route at all? */
  called: (route: string, method?: string) => boolean;
  /** True if any upstream call came back 429 — the key's budget is spent. */
  rateLimited: boolean;
};

/**
 * Drive one scenario end to end and return what actually happened.
 *
 * The agent is reached only over HTTP, and its view of the dental API is the
 * proxy — so nothing here depends on how the agent is implemented.
 */
export async function runScenario(persona: Persona): Promise<RunResult> {
  const { baseUrl, apiKey } = apiConfig();
  const runId = `e2e-${persona.id}-${randomUUID()}`;

  const proxy = await startProxy({
    target: baseUrl,
    scenario: persona.id,
    maxBookings: persona.maxBookings,
  });

  const transcript: Exchange[] = [];

  try {
    let message = await openingMessage(persona);

    for (let turn = 1; turn <= persona.maxTurns; turn++) {
      transcript.push({ role: 'patient', content: message });

      const response = await sendTurn({
        agentUrl: AGENT_URL,
        runId,
        turnNumber: turn,
        message,
        // The agent is entitled to reconstruct from history, so send it.
        history: transcript.slice(0, -1),
        dentalApi: { base_url: proxy.origin, api_key: apiKey },
      });

      if (response.status !== 200) {
        throw new Error(
          `agent returned ${response.status} on turn ${turn}: ` +
            JSON.stringify(response.body).slice(0, 300),
        );
      }

      const reply = response.body.output?.message ?? '';
      transcript.push({ role: 'agent', content: reply });

      if (response.body.status === 'complete') break;

      const next = await replyTo(persona, transcript);
      if (next === null) break;

      message = next;
    }
  } finally {
    saveTranscript(persona, runId, transcript, proxy.calls);
    await proxy.close();
  }

  const routes = new Set(proxy.calls.map((c) => `${c.method} ${c.route}`));

  return {
    persona,
    runId,
    transcript,
    calls: proxy.calls,
    appointmentIds: [...proxy.appointmentIds],
    refusedBookings: proxy.refusedBookings,
    called: (route, method = 'POST') => routes.has(`${method} ${route}`),
    rateLimited: proxy.calls.some((c) => c.status === 429),
  };
}

/**
 * Cancel everything a run created.
 *
 * Called from `afterEach`, not just at the end of the suite: a slot held by a
 * test appointment is a slot no later test can book, and the sandbox is shared.
 */
export async function cleanup(appointmentIds: string[]): Promise<void> {
  if (appointmentIds.length === 0) return;

  const api = createClient(apiConfig());
  const released = new Set<string>();

  for (const id of appointmentIds) {
    try {
      await api.cancelAppointment(id);
      released.add(id);
    } catch (err) {
      // Already cancelled is a success for our purposes; anything else is
      // shouted about, because a leak here permanently consumes a real slot.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('NOT_FOUND') || message.includes('404')) {
        released.add(id);
      } else {
        console.error(`⚠️  could not cancel appointment ${id}: ${message}`);
      }
    }
  }

  markReleased(released);
}

function saveTranscript(
  persona: Persona,
  runId: string,
  transcript: Exchange[],
  calls: RecordedCall[],
) {
  const dir = join(process.cwd(), 'e2e', '.artifacts', 'transcripts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, `${persona.id}-${Date.now()}.json`),
    JSON.stringify({ persona: persona.id, runId, transcript, calls }, null, 2),
    'utf8',
  );
}

/** Renders a transcript for an assertion message, so failures are debuggable. */
export const formatTranscript = (transcript: Exchange[]): string =>
  '\n' +
  transcript
    .map((t) => `${t.role === 'patient' ? 'PATIENT' : 'AGENT  '}: ${t.content}`)
    .join('\n') +
  '\n';

/** All agent replies joined — for coarse content checks on judged scenarios. */
export const agentText = (transcript: Exchange[]): string =>
  transcript
    .filter((t) => t.role === 'agent')
    .map((t) => t.content)
    .join('\n');
