'use client';

import { useEffect, useRef, type FormEvent } from 'react';
import type { AgentMessage } from '@/lib/agent';
import { PRACTICE } from '@/lib/config';
import { TOOL_LABELS, toolName } from './tool-labels';

/**
 * The patient's half of the screen.
 *
 * Everything here is what a real patient would see and nothing else — no tool
 * names, no ids, no error codes. If something needs to be visible for testing,
 * it belongs in the inspector, not here.
 */

/**
 * Openers the agent can actually see through to an end.
 *
 * "I need to cancel my appointment" used to sit here, and it walked a first-time
 * visitor straight into the one thing this cannot do: there is no endpoint that
 * looks a patient's appointments up, so cancelling only reaches one booked in
 * the conversation you are already having. The agent handles that gracefully —
 * it says it cannot pull the appointment up and gives out the office number —
 * but a starter chip is a promise, and that is not one to make first.
 */
const OPENERS = [
  'I need to book a cleaning',
  'My tooth has been hurting since Friday',
  'What are your hours?',
  'Do you take Delta Dental?',
];

type Props = {
  messages: AgentMessage[];
  input: string;
  onInput: (value: string) => void;
  onSend: (text: string) => void;
  busy: boolean;
};

export function ChatPane({ messages, input, onInput, onSend, busy }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    onSend(input);
  }

  return (
    <section className="flex min-w-0 flex-col bg-paper">
      <header className="flex items-baseline gap-3 border-b border-rule px-8 py-5">
        <span
          aria-hidden
          className="size-2 rounded-full bg-clinical"
        />
        <div>
          <h1 className="font-display text-xl leading-tight tracking-tight text-ink">
            {PRACTICE.name}
          </h1>
          <p className="text-[13px] text-ink-soft">
            {PRACTICE.hours} &middot; {PRACTICE.phone}
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto flex max-w-[34rem] flex-col gap-5">
          {messages.length === 0 ? (
            <Welcome onPick={onSend} disabled={busy} />
          ) : (
            messages.map((message) => (
              <Message key={message.id} message={message} />
            ))
          )}

          {busy && !hasStreamingText(messages) && <Ellipsis />}
          <div ref={bottomRef} />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="border-t border-rule px-8 py-5">
        <div className="mx-auto flex max-w-[34rem] items-center gap-2 rounded-full border border-rule bg-card px-2 py-1.5 shadow-sm transition focus-within:border-clinical/50 focus-within:shadow-md">
          <input
            value={input}
            onChange={(e) => onInput(e.currentTarget.value)}
            disabled={busy}
            placeholder="Type as the patient…"
            aria-label="Message"
            className="min-w-0 flex-1 bg-transparent px-3 py-1.5 text-[15px] text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="shrink-0 rounded-full bg-clinical px-4 py-2 text-[13px] font-medium text-white transition hover:bg-clinical/90 disabled:opacity-30"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

function Welcome({
  onPick,
  disabled,
}: {
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="pt-6">
      <p className="font-display text-2xl leading-snug text-ink">
        Hi — how can I help?
      </p>
      {/*
        Only what it can do. This said "book, reschedule, or cancel" — there is
        no reschedule tool at all, and a patient told otherwise spends their
        first turn asking for something the answer has to walk back.
      */}
      <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-ink-soft">
        I can book an appointment, sort out insurance, and answer questions about
        the office.
      </p>

      <div className="mt-7 flex flex-wrap gap-2">
        {OPENERS.map((opener) => (
          <button
            key={opener}
            type="button"
            disabled={disabled}
            onClick={() => onPick(opener)}
            className="rounded-full border border-rule bg-card px-3.5 py-1.5 text-[13px] text-ink-soft transition hover:border-clinical/40 hover:text-clinical disabled:opacity-40"
          >
            {opener}
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ message }: { message: AgentMessage }) {
  if (message.role === 'user') {
    const text = message.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');

    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-clinical px-4 py-2.5 text-[15px] leading-relaxed text-white">
          {text}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-[92%] space-y-2">
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          return (
            <p
              key={i}
              className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink"
            >
              {part.text}
            </p>
          );
        }

        // A quiet status line while a tool is in flight, dropped once the result
        // lands — the model narrates the outcome itself.
        if (part.type.startsWith('tool-') && 'state' in part) {
          const label = TOOL_LABELS[toolName(part.type)];
          if (!label || part.state === 'output-available') return null;

          return (
            <p key={i} className="flex items-center gap-2 text-[13px] text-ink-faint">
              <Spinner />
              {label}…
            </p>
          );
        }

        return null;
      })}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 animate-spin rounded-full border border-ink-faint border-t-transparent"
    />
  );
}

function Ellipsis() {
  return (
    <div className="flex gap-1 py-1" aria-label="Thinking">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-bounce rounded-full bg-ink-faint"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

/** True once the assistant has started saying something, so we drop the dots. */
function hasStreamingText(messages: AgentMessage[]) {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return false;

  return last.parts.some((p) => p.type === 'text' && p.text.length > 0);
}
