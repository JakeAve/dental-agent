import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../lib/cedar-ridge';
import { PERSONAS } from './support/personas';
import { apiConfig, cleanup, formatTranscript, runScenario } from './support/run';
import { SERVICE } from './support/verify';

/**
 * S37 — availability comes back ten slots at a time.
 *
 * The failure this guards against is quiet and expensive: availability is
 * paginated and ordered earliest-first, so page one of a month-long window
 * often reaches only a day or two in. An agent that treats that page as the
 * whole schedule tells patients a month is full when it has openings all
 * through it — and nothing in the response looks like an error.
 *
 * Assertions are on the query strings the agent actually sent, so nothing here
 * depends on which particular slots the sandbox is holding on the day.
 */

let created: string[] = [];

afterEach(async () => {
  await cleanup(created);
  created = [];
});

/** Claims that the times shown were all the times there are. */
const CLAIMS_EXHAUSTED =
  /\b(?:that(?:'s| is) (?:all|everything)|no (?:other|more|further) (?:times|openings|slots|availability)|nothing else (?:is )?(?:available|open)|fully booked|no availability)\b/i;

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The scenario's fixture requirement, checked rather than assumed: a month-long
 * window for a returning patient must hold more than one page of openings. If
 * the sandbox were nearly full, "the agent should have paged" would be a
 * demand for something that does not exist.
 */
let totalPages = 0;

beforeAll(async () => {
  const api = createClient(apiConfig());
  const persona = PERSONAS.S37;

  // Create-or-identify against the persona's own stable identity, so this adds
  // no record the scenario would not have created anyway.
  const patient = await api.registerPatient({
    status: 'returning',
    first_name: persona.facts['full name'].split(' ')[0],
    last_name: persona.facts['full name'].split(' ').slice(1).join(' '),
    date_of_birth: persona.facts['date of birth'],
    phone: persona.facts.phone,
    email: persona.facts.email,
  });

  await api.setInsurance(patient.id, { self_pay: true });

  const now = new Date();
  const probe = await api.getAvailability({
    service: SERVICE.cleaning,
    patient_id: patient.id,
    from: iso(now),
    to: iso(new Date(now.getTime() + 30 * DAY_MS)),
  });

  totalPages = probe.total_pages;
}, 60_000);

describe('availability pagination', () => {
  it(
    'S37 — looks past the first page instead of calling the window empty',
    { timeout: 240_000 },
    async () => {
      expect(
        totalPages,
        'fixture not satisfied: a 30-day window has only ' +
          `${totalPages} page(s) of openings, so there is no paging to test. ` +
          'Free up the sandbox (npm run e2e:cleanup) and retry.',
      ).toBeGreaterThan(1);

      const run = await runScenario(PERSONAS.S37);
      created = run.appointmentIds;

      expect(run.rateLimited, 'the run key hit its budget (429)').toBe(false);
      expect(
        run.appointmentIds,
        `nothing should have been booked.${formatTranscript(run.transcript)}`,
      ).toHaveLength(0);

      const searches = run.calls.filter(
        (c) => c.route === '/api/v1/availability' && c.status === 200,
      );

      expect(
        searches.length,
        `the agent never searched availability successfully.${formatTranscript(run.transcript)}`,
      ).toBeGreaterThan(0);

      const queries = searches.map((call) => {
        const params = new URL(`http://x${call.path}`).searchParams;
        return {
          from: params.get('from'),
          to: params.get('to'),
          label:
            `page=${params.get('page') ?? '1'} ` +
            `from=${params.get('from') ?? '-'} to=${params.get('to') ?? '-'}`,
        };
      });

      // The patient asked twice for more options, so the agent had to look
      // somewhere new — a later page, or a narrowed window. Either is correct.
      // Re-sending the identical query is not, and nor is refusing to look.
      const distinct = new Set(queries.map((q) => q.label));

      expect(
        distinct.size,
        `the agent searched ${searches.length} time(s) but sent only ` +
          `${distinct.size} distinct query — it repeated the same search ` +
          'rather than looking further into the window:\n' +
          queries.map((q) => `  ${q.label}`).join('\n') +
          formatTranscript(run.transcript),
      ).toBeGreaterThanOrEqual(2);

      // A re-scoped window must still be a valid one (S39's range guard): an
      // inverted range is a 422 the patient experiences as a dead end.
      for (const q of queries) {
        if (q.from && q.to) {
          expect(
            q.from <= q.to,
            `inverted availability range: from=${q.from} to=${q.to}`,
          ).toBe(true);
        }
      }

      // The headline anti-assertion: pages remain (asserted above), so no reply
      // may tell the patient there is nothing else.
      const exhausted = run.transcript
        .filter((t) => t.role === 'agent')
        .find((t) => CLAIMS_EXHAUSTED.test(t.content));

      expect(
        exhausted,
        `the window has ${totalPages} pages of openings, but the agent said: ` +
          `"${exhausted?.content}"` +
          formatTranscript(run.transcript),
      ).toBeUndefined();
    },
  );
});
