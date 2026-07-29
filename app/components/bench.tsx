'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useState } from 'react';
import type { AgentMessage } from '@/lib/agent';
import type { SessionSnapshot } from '@/lib/session';
import { ChatPane } from './chat-pane';
import { Inspector } from './inspector';

/**
 * The hand-testing bench.
 *
 * Left is the patient's view, right is the machine's. The split is the whole
 * design: you read the reply on one side, and check on the other whether the
 * agent had any right to say it.
 */

export function Bench({ initialConversationId }: { initialConversationId: string }) {
  /**
   * Seeded from the server rather than minted here. The id has to be random —
   * it keys the tool session, and two tabs sharing one would trample each
   * other's patient — but a random value produced during render differs between
   * the server pass and the client pass, which is a hydration mismatch. Reset
   * mints a new one from an event handler, where that is not a concern.
   */
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [input, setInput] = useState('');

  /**
   * The session arrives as a transient data part, so it never lands in the
   * message list. Kept here with the time it arrived, so the hold countdown can
   * tick locally rather than polling the server every second.
   */
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);

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

  /**
   * A new id, not just a cleared list. The server keys its session by this id,
   * so reusing it would leave the old patient and hold attached to a chat that
   * looks empty — exactly the confusion this bench exists to prevent. The `key`
   * on the subtree drops the rest.
   */
  const reset = useCallback(() => {
    setSnapshot(null);
    setInput('');
    setConversationId(crypto.randomUUID());
  }, []);

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
        onReset={reset}
      />
    </main>
  );
}
