import { CedarRidgeError } from './cedar-ridge';

/**
 * What may be said about a failure on a request that carries a credential.
 *
 * The protocol is unconditional: *"Never log or return the supplied Scheduling
 * API key."* An error message is not a safe place to look for that guarantee.
 * It is written by whoever threw — the runtime, the model SDK, an HTTP client,
 * a Redis client that likes to echo the command it was running — and a
 * credential arrives in this process on every single turn. `cedar-ridge.ts`
 * keeps the URL and headers out of its own errors deliberately, but "our own
 * code is careful" is a property of today's dependencies, not a rule.
 *
 * So failures are logged by class, plus a code where the code comes from a
 * closed set. That is enough to tell a lapsed hold from a network fault from a
 * bug in the loop, which is what the log is read for, and it cannot carry a
 * secret it was never given.
 */
export function errorLabel(err: unknown): string {
  if (err instanceof CedarRidgeError) {
    return `CedarRidgeError:${err.code}:${err.status}`;
  }

  if (err instanceof Error) {
    // AbortError and the like: the name is the diagnosis.
    return err.name || 'Error';
  }

  return typeof err === 'string' ? 'thrown string' : 'unknown error';
}
