/**
 * Sweep the sandbox for appointments the tests created and never released.
 *
 *   npm run e2e:cleanup
 *
 * The safety net behind `afterEach`. If a run is killed mid-test — Ctrl-C, a
 * crash, a laptop lid — the appointment is already on disk in the ledger but
 * was never cancelled, and there is no endpoint that lists appointments, so
 * nothing else can ever find it. This is the only way back.
 */
import { createClient } from '../lib/cedar-ridge';
import { markReleased, outstandingAppointments } from '../e2e/support/ledger';

async function main() {
  const outstanding = outstandingAppointments();

  if (outstanding.length === 0) {
    console.log('✅ Nothing outstanding — the sandbox is clean.');
    return;
  }

  console.log(`Found ${outstanding.length} uncancelled appointment(s).\n`);

  const baseUrl = process.env.CEDAR_RIDGE_BASE_URL;
  const apiKey = process.env.CEDAR_RIDGE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('CEDAR_RIDGE_BASE_URL and CEDAR_RIDGE_API_KEY must be set');
  }

  const api = createClient({ baseUrl, apiKey });
  const released = new Set<string>();
  let failed = 0;

  for (const entry of outstanding) {
    try {
      const appt = await api.cancelAppointment(entry.id);
      released.add(entry.id);
      console.log(`  ✓ ${entry.scenario} ${entry.id} → ${appt.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Already gone counts as released — the slot is free either way.
      if (message.includes('NOT_FOUND') || message.includes('404')) {
        released.add(entry.id);
        console.log(`  ✓ ${entry.scenario} ${entry.id} → already gone`);
      } else {
        failed += 1;
        console.error(`  ✗ ${entry.scenario} ${entry.id} → ${message}`);
      }
    }
  }

  markReleased(released);

  console.log(`\nReleased ${released.size}, failed ${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n❌ Cleanup failed:\n', err);
  process.exit(1);
});
