import { randomUUID } from 'node:crypto';

/**
 * A raw candidate-agent/1 client.
 *
 * Deliberately dumb: it knows the wire contract and nothing about the agent.
 * If the implementation is rewritten in Go tomorrow, this file is unchanged.
 */

export type TurnResponse = {
  status: number;
  body: {
    protocol_version?: string;
    run_id?: string;
    turn_id?: string;
    output?: { message?: string };
    status?: 'continue' | 'complete';
    error?: string;
  };
};

export type TurnOptions = {
  agentUrl: string;
  runId: string;
  turnId?: string;
  turnNumber?: number;
  message: string;
  history?: Array<{ role: 'patient' | 'agent'; content: string }>;
  dentalApi: { base_url: string; api_key: string };
  protocolVersion?: string;
};

export async function sendTurn(options: TurnOptions): Promise<TurnResponse> {
  const res = await fetch(options.agentUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol_version: options.protocolVersion ?? 'candidate-agent/1',
      run_id: options.runId,
      turn_id: options.turnId ?? randomUUID(),
      turn_number: options.turnNumber,
      input: { message: options.message, history: options.history ?? [] },
      resources: { dental_api: options.dentalApi },
    }),
  });

  const text = await res.text();

  let body: TurnResponse['body'];
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `agent returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  return { status: res.status, body };
}

/** Posts an arbitrary body — for conformance tests that send malformed input. */
export async function sendRaw(agentUrl: string, body: unknown): Promise<TurnResponse> {
  const res = await fetch(agentUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const text = await res.text();

  return {
    status: res.status,
    body: text ? (JSON.parse(text) as TurnResponse['body']) : {},
  };
}
