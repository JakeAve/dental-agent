'use client';

import { useState } from 'react';
import type { AgentMessage } from '@/lib/agent';
import type { SessionSnapshot } from '@/lib/session';
import { SessionPanel } from './session-panel';
import { ToolTrace } from './tool-trace';

/**
 * The tester's half of the screen: what the agent did, as opposed to what it
 * said. Session state on top because it is small and always relevant; the trace
 * below because it grows without bound.
 */

export function Inspector({
  messages,
  snapshot,
  receivedAt,
  conversationId,
  onReset,
}: {
  messages: AgentMessage[];
  snapshot: SessionSnapshot | null;
  receivedAt: number;
  conversationId: string;
  onReset: () => void;
}) {
  const [showSession, setShowSession] = useState(true);

  return (
    <aside className="flex min-h-0 flex-col bg-rail text-rail-text">
      <header className="flex items-center gap-3 border-b border-rail-rule px-4 py-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-signal">
          Inspector
        </h2>
        <span
          className="ml-auto truncate font-mono text-[10px] text-rail-dim"
          title={conversationId}
        >
          {conversationId.slice(0, 8)}
        </span>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 rounded border border-rail-rule px-2 py-1 font-mono text-[10px] text-rail-dim transition hover:border-signal/50 hover:text-signal"
        >
          new chat
        </button>
      </header>

      <Section
        title="session"
        hint="what the tools act on"
        open={showSession}
        onToggle={() => setShowSession((s) => !s)}
      >
        <SessionPanel snapshot={snapshot} receivedAt={receivedAt} />
      </Section>

      <div className="flex min-h-0 flex-1 flex-col border-t border-rail-rule">
        <div className="flex items-baseline gap-2 px-4 py-2.5">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-rail-dim">
            trace
          </h3>
          <span className="font-mono text-[10px] text-rail-dim/60">
            every call, in order
          </span>
        </div>
        <div className="rail-scroll min-h-0 flex-1 overflow-y-auto">
          <ToolTrace messages={messages} />
        </div>
      </div>
    </aside>
  );
}

function Section({
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto rail-scroll">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 px-4 py-2.5 text-left"
      >
        <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-rail-dim">
          {title}
        </h3>
        <span className="font-mono text-[10px] text-rail-dim/60">{hint}</span>
        <span className="ml-auto font-mono text-[10px] text-rail-dim">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && children}
    </div>
  );
}
