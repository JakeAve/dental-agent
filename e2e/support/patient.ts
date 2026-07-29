import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { Persona } from './personas';

/**
 * The synthetic patient — a model playing a persona, mirroring how the real
 * evaluator drives the agent.
 *
 * Two rules make this usable as a test driver rather than a source of noise:
 *
 *   1. **It may not invent facts.** Everything it knows is in `persona.facts`.
 *      A patient that improvises a member ID produces a red test that is our
 *      bug, not the agent's, and that is the failure mode that gets suites
 *      muted and ignored.
 *   2. **It never decides pass or fail.** It only talks. Verdicts are asserted
 *      in code against the API's actual state.
 */

export type Exchange = { role: 'patient' | 'agent'; content: string };

const DONE = '[DONE]';

function systemPrompt(persona: Persona): string {
  const facts = Object.entries(persona.facts)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  return `You are role-playing a dental patient in a text conversation with a
scheduling assistant. You are the PATIENT, never the assistant.

Your goal: ${persona.goal}
${persona.style ? `\nYour manner: ${persona.style}\n` : ''}
Everything you know about yourself:
${facts}

Rules you must follow exactly:

- Never invent a fact about yourself that is not listed above. If you are asked
  for something not on that list — an insurance member ID you do not have, a
  second phone number, a previous appointment date — say plainly that you do
  not have it or do not know. Making something up is the single worst thing you
  can do here.
- Answer only what you were asked. Do not volunteer your whole life story, and
  do not dump every fact at once unless asked to.
- Write one short message per turn, the way a real person texts. No lists, no
  headings, no stage directions, no quotation marks around your reply.
- Stay in character. If the assistant asks something confusing, react like a
  person would rather than helpfully re-explaining its job to it.
- When your goal is met, or the assistant has clearly finished and there is
  nothing left for you to say, reply with exactly ${DONE} and nothing else.
- If the assistant asks you to confirm something your goal says you should NOT
  confirm, decline politely and then reply ${DONE} on the following turn.

Reply with your next message only.`;
}

/** The persona's opening line, generated in character. */
export async function openingMessage(persona: Persona): Promise<string> {
  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
    system: systemPrompt(persona),
    temperature: 0,
    messages: [
      {
        role: 'user',
        content:
          'Start the conversation. Write your first message to the scheduling ' +
          'assistant.',
      },
    ],
  });

  return text.trim();
}

/**
 * The persona's reply to the agent, or null when the conversation is over.
 */
export async function replyTo(
  persona: Persona,
  transcript: Exchange[],
): Promise<string | null> {
  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
    system: systemPrompt(persona),
    temperature: 0,
    messages: transcript.map((turn) => ({
      // The patient's own past lines are the assistant role from its point of
      // view; the agent's lines are what it is responding to.
      role: turn.role === 'patient' ? ('assistant' as const) : ('user' as const),
      content: turn.content,
    })),
  });

  const reply = text.trim();

  return reply.includes(DONE) ? null : reply;
}
