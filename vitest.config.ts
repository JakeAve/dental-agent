import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Vitest has no --env-file flag, and the suite needs the sandbox credentials
// before globalSetup runs. Real env vars still win, so CI can inject its own.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['e2e/**/*.spec.ts'],
    globalSetup: ['e2e/globalSetup.ts'],
    // Serial, deliberately. The sandbox is shared and stateful: personas have
    // stable identities and a patient may hold only one slot at a time, so
    // parallel scenarios would contend for both slots and holds.
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
});
