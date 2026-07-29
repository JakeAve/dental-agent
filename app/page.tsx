'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useEffect, useState } from 'react';
import type { AgentMessage } from '@/lib/agent';
import type { SessionSnapshot } from '@/lib/session';
import { ChatPane } from './components/chat-pane';
import { Inspector } from './components/inspector';

/**
 * The hand-testing bench.
 *
 * Left is the patient's view, right is the machine's. The split is the whole
 * design: you read the reply on one side and check on the other whether the
 * agent had any right to say it.
 */

export default function Page() {
  /**
   * Minted after mount, not during render. A random id generated in a `useState`
   * initializer is generated twice — once on the server, once on the client —
   * and the two never match, which is a hydration error. Two tabs also need two
   * different ids, so `useId` is not a substitute.
   */
  const [conversationId, setConversationId] = useState<string | null>(null);

  useEffect(() => setConversationId(crypto.randomUUID()), []);

  const reset = useCallback(() => setConversationId(crypto.randomUUID()), []);

  // Keyed so a reset discards every scrap of the old conversation's state.
  return conversationId ? (
    <Bench key={conversationId} conversationId={conversationId} onReset={reset} />
  ) : (
    <main className="h-dvh bg-paper" />
  );
}

function Bench({
  conversationId,
  onReset,
}: {
  conversationId: string;
  onReset: () => void;
}) {
  const [input, setInput] = useState('');

  /**
   * The session arrives as a transient data part, so it never lands in the
   * message list. Kept here with the time it arrived, so the hold countdown can
   * tick locally rather than polling the server every second.
   */
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());

  const { messages, sendMessage, status } = useChat<AgentMessage>({
    id: conversationId,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: { conversationId },
    }),
    onData: (part) => {
      if (part.type !== 'data-session') return;
      setSnapshot(part.data);
      setReceivedAt(Date.now());
    },
  });

  const busy = status === 'submitted' || status === 'streaming';

  const send = useCallback(
    (text: string) => {
      if (!text.trim() || busy) return;
      sendMessage({ text });
      setInput('');
    },
    [busy, sendMessage],
  );

  return (
    <main className="grid h-dvh grid-cols-1 lg:grid-cols-[minmax(0,1fr)_26rem]">
      <ChatPane
        messages={messages}
        input={input}
        onInput={setInput}
        onSend={send}
        busy={busy}
      />
      <Inspector
        messages={messages}
        snapshot={snapshot}
        receivedAt={receivedAt}
        conversationId={conversationId}
        onReset={onReset}
      />
    </main>
  );
}
