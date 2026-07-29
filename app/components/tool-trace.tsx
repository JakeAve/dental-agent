'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentMessage } from '@/lib/agent';
import { TOOL_STAGE, toolName } from './tool-labels';

/**
 * Every tool call the agent made, in order, with its arguments and its result.
 *
 * Derived entirely from the message parts the transport already streams — there
 * is no second channel to keep in sync. A call that failed is expanded by
 * default, because that is always the one you opened the panel to read.
 */

type Call = {
  id: string;
  turn: number;
  name: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function collectCalls(messages: AgentMessage[]): Call[] {
  const calls: Call[] = [];
  let turn = 0;

  for (const message of messages) {
    if (message.role === 'user') turn += 1;
    if (message.role !== 'assistant') continue;

    for (const part of message.parts) {
      if (!part.type.startsWith('tool-') || !('state' in part)) continue;

      const p = part as {
        toolCallId?: string;
        state: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
      };

      calls.push({
        id: p.toolCallId ?? `${message.id}-${calls.length}`,
        turn,
        name: toolName(part.type),
        state: p.state,
        input: p.input,
        output: p.output,
        errorText: p.errorText,
      });
    }
  }

  return calls;
}

/** A tool that returned `{ok: false, …}` succeeded as HTTP and failed as work. */
function failed(call: Call) {
  if (call.state === 'output-error') return true;

  const output = call.output;
  return (
    typeof output === 'object' &&
    output !== null &&
    'ok' in output &&
    (output as { ok: unknown }).ok === false
  );
}

export function ToolTrace({ messages }: { messages: AgentMessage[] }) {
  const calls = collectCalls(messages);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [calls.length]);

  if (!calls.length) {
    return (
      <p className="px-4 py-3 font-mono text-[11px] text-rail-dim">
        no tool calls yet
      </p>
    );
  }

  return (
    <div className="pb-4">
      {calls.map((call, i) => (
        <CallRow
          key={call.id}
          call={call}
          newTurn={i === 0 || calls[i - 1].turn !== call.turn}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

const STAGE_DOT: Record<string, string> = {
  lookup: 'bg-rail-dim',
  patient: 'bg-signal-warn',
  booking: 'bg-signal',
};

function CallRow({ call, newTurn }: { call: Call; newTurn: boolean }) {
  const bad = failed(call);
  const [open, setOpen] = useState(bad);
  const running = call.state !== 'output-available' && call.state !== 'output-error';

  return (
    <>
      {newTurn && (
        <div className="flex items-center gap-2 px-4 pt-4 pb-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-rail-dim">
            turn {call.turn}
          </span>
          <span className="h-px flex-1 bg-rail-rule" />
        </div>
      )}

      <div className="px-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition hover:bg-rail-raised"
          aria-expanded={open}
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${
              bad ? 'bg-signal-bad' : STAGE_DOT[TOOL_STAGE[call.name]] ?? 'bg-rail-dim'
            } ${running ? 'animate-pulse' : ''}`}
          />
          <span
            className={`font-mono text-[11px] ${
              bad ? 'text-signal-bad' : 'text-rail-text'
            }`}
          >
            {call.name}
          </span>
          {running && (
            <span className="font-mono text-[10px] text-rail-dim">running…</span>
          )}
          <span className="ml-auto font-mono text-[10px] text-rail-dim">
            {open ? '−' : '+'}
          </span>
        </button>

        {open && (
          <div className="space-y-1.5 px-4 pb-2 pt-0.5">
            <Json label="in" value={call.input} />
            {call.errorText ? (
              <p className="font-mono text-[11px] text-signal-bad">
                {call.errorText}
              </p>
            ) : (
              <Json label="out" value={call.output} bad={bad} />
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Json({
  label,
  value,
  bad,
}: {
  label: string;
  value: unknown;
  bad?: boolean;
}) {
  if (value === undefined) return null;

  return (
    <div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-rail-dim">
        {label}
      </span>
      <pre
        className={`mt-0.5 overflow-x-auto rounded bg-rail-panel px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-words ${
          bad ? 'text-signal-bad/90' : 'text-rail-text/85'
        }`}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
