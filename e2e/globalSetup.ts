import { spawn, type ChildProcess } from 'node:child_process';
import { outstandingAppointments } from './support/ledger';

/**
 * Owns the dev server for the whole suite, so `npm run e2e` works from cold.
 *
 * Set E2E_AGENT_URL to point at an already-running server (or a deployed one)
 * and this skips spawning entirely — useful when debugging with a server you
 * control, and the reason the suite is not coupled to Next.js.
 */

let server: ChildProcess | undefined;

const READY_TIMEOUT_MS = 60_000;
const PORT = process.env.E2E_PORT ?? '3000';

async function waitForReady(url: string, deadlineMs: number) {
  const until = Date.now() + deadlineMs;

  while (Date.now() < until) {
    try {
      // Any HTTP answer means the server is up; a 400 from an empty POST is a
      // perfectly good readiness signal.
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error(`server did not become ready within ${deadlineMs}ms`);
}

export async function setup() {
  // Leftovers from a previous crashed run occupy real slots in a shared,
  // persistent sandbox. Surface them loudly rather than letting them rot.
  const stale = outstandingAppointments();
  if (stale.length > 0) {
    console.warn(
      `\n⚠️  ${stale.length} appointment(s) from a previous run were never ` +
        'cancelled.\n   Run `npm run e2e:cleanup` to release them.\n',
    );
  }

  if (process.env.E2E_AGENT_URL) {
    console.log(`▸ using existing agent at ${process.env.E2E_AGENT_URL}`);
    return;
  }

  const url = `http://127.0.0.1:${PORT}/api/evaluation-turn`;
  process.env.E2E_AGENT_URL = url;

  console.log('▸ starting dev server…');

  server = spawn('npx', ['next', 'dev', '--port', PORT], {
    stdio: 'ignore',
    env: process.env,
    // Own process group, so teardown kills the whole tree rather than leaving
    // an orphan holding the port.
    detached: true,
  });

  await waitForReady(url, READY_TIMEOUT_MS);
  console.log(`▸ agent ready at ${url}`);
}

export async function teardown() {
  if (!server?.pid) return;

  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}
