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
