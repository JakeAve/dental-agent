import { Bench } from './components/bench';

/**
 * Every load gets its own conversation id, minted here so the server and client
 * renders agree on it. Rendering must therefore be dynamic — prerendered, one
 * id would be baked into the HTML and every visitor would share a session.
 */
export const dynamic = 'force-dynamic';

export default function Page() {
  return <Bench initialConversationId={crypto.randomUUID()} />;
}
