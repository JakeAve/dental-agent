import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from 'ai';
import { runAgentForUI, type AgentMessage } from '@/lib/agent';
import { getChatSession } from '@/lib/chat-store';
import { sessionSnapshot } from '@/lib/session';

// Booking can take several tool round-trips. Literal, not a config import:
// Next statically analyses segment config and rejects computed values.
export const maxDuration = 60;

export async function POST(req: Request) {
  const {
    messages,
    conversationId,
  }: { messages: AgentMessage[]; conversationId?: string } = await req.json();

  // A missing id would silently hand every request its own session — the exact
  // bug chat-store exists to fix — so fail loudly rather than degrade quietly.
  if (!conversationId) {
    return Response.json({ error: 'conversationId is required' }, { status: 400 });
  }

  const session = getChatSession(conversationId);

  const stream = createUIMessageStream<AgentMessage>({
    execute: async ({ writer }) => {
      /**
       * Transient: the snapshot is current state, not a fact about this turn.
       * Appending it to the message would leave a trail of stale copies in the
       * transcript, and they would be replayed to the model next turn. The
       * client keeps only the latest, via `onData`.
       */
      const publish = () =>
        writer.write({
          type: 'data-session',
          data: sessionSnapshot(session),
          transient: true,
        });

      publish();

      const result = await runAgentForUI(messages, session, publish);
      writer.merge(toUIMessageStream({ stream: result.stream }));

      // Hold the writer open until generation settles, so the closing snapshot
      // reflects the last tool call instead of racing the stream shut.
      await result.finishReason;
      publish();
    },
    onError: (error) => (error instanceof Error ? error.message : 'Unknown error'),
  });

  return createUIMessageStreamResponse({ stream });
}
