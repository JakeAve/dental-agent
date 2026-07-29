/**
 * gpt-5.4-mini occasionally restarts its reply inside a single completion:
 * the message arrives as draft one, a newline, then a second full draft that
 * opens with the same sentence (sometimes identical, sometimes rewritten).
 * Observed roughly twice in thirteen conversations; the raw string from the
 * API already contains both copies, so it is not the loop's doing. Kin to the
 * occasional empty completion handled in app/api/evaluation-turn/route.ts.
 */

/**
 * Collapse a restarted reply to its final draft.
 *
 * A restart is recognized by the reply's opening sentence reappearing verbatim
 * at the start of a later line, with a comparably sized draft on each side.
 * The size check is what spares a genuine closing restatement ("Your cleaning
 * is booked for…" repeated as a sign-off), which leaves the tail far shorter
 * than the body. When in doubt, the text passes through untouched.
 */
/**
 * Ceiling on `output.message`, in UTF-8 bytes.
 *
 * The protocol's own limit is a 256 KiB body, and an oversized response is not
 * a bad answer — it "ends the run as a candidate-endpoint error", losing every
 * turn that came before it. This sits far below that for two reasons: JSON
 * escaping can multiply a pathological string several times over on the way
 * into the body, and nothing a receptionist would say comes close to 32 KiB.
 * A reply that reaches this has already gone wrong; the cap only decides
 * whether it goes wrong as a long answer or as a dead run.
 */
export const MAX_MESSAGE_BYTES = 32 * 1024;

const utf8 = new TextEncoder();

/**
 * Trim a reply to the byte ceiling, on a boundary the patient can read.
 *
 * Cutting by byte index alone can split a multi-byte character, so the trim
 * walks back to whitespace where it can — and always returns something
 * non-empty, because an empty `output.message` is itself a protocol violation.
 */
export function capMessage(text: string): string {
  if (utf8.encode(text).length <= MAX_MESSAGE_BYTES) return text;

  // Slice by code point, then tighten until the encoded form fits: characters
  // vary between one and four bytes, so one pass cannot know where to stop.
  const points = [...text];
  let kept = points.slice(0, MAX_MESSAGE_BYTES);
  while (utf8.encode(kept.join('')).length > MAX_MESSAGE_BYTES - 1) {
    kept = kept.slice(0, Math.floor(kept.length * 0.9));
  }

  const trimmed = kept.join('');
  const lastBreak = trimmed.lastIndexOf(' ');
  const clean = (lastBreak > MAX_MESSAGE_BYTES / 2 ? trimmed.slice(0, lastBreak) : trimmed)
    .trimEnd();

  return `${clean}…`;
}

export function collapseRestartedReply(text: string): string {
  // The shortest prefix of at least 20 characters ending a sentence. The
  // length floor keeps abbreviations ("Dr.") and stub sentences from matching.
  const opening = text.match(/^[\s\S]{19,}?[.?!](?=\s)/)?.[0];
  if (!opening) return text;

  let restart = -1;
  for (
    let idx = text.indexOf(opening, opening.length);
    idx !== -1;
    idx = text.indexOf(opening, idx + 1)
  ) {
    if (text[idx - 1] === '\n') restart = idx;
  }
  if (restart === -1) return text;

  const before = text.slice(0, restart).trim();
  const after = text.slice(restart).trim();
  return after.length * 2 < before.length ? text : after;
}
