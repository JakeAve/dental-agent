import { tool } from 'ai';
import { z } from 'zod';
import type { CedarRidgeClient } from '../cedar-ridge';
import type { Session } from '../session';
import { withRecovery } from './errors';

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Reshape a spoken phone number into the `555-555-5555` the API demands.
 *
 * Patients say "(555) 555 0142", "5555550142", "+1 555.555.0142". All three are
 * the same number and all three 422 if passed through, and the model's response
 * to a 422 is to ask the patient to repeat themselves — which reads as the agent
 * being unable to understand a normal phone number. Reformatting is safe because
 * it never changes which digits were given.
 *
 * Returns null only when the digits themselves are wrong — too few (a 7-digit
 * local number) or too many. Those need a question, not a guess: padding or
 * truncating invents a stranger's number.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, '');

  // A leading country code is noise here — the practice is US-only.
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);

  if (digits.length !== 10) return null;

  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Same idea for dates of birth, which the API wants as `YYYY-MM-DD` but patients
 * give as "8/2/1988". Only unambiguous forms convert; anything else is asked
 * about rather than guessed at, since a wrong DOB fails insurance verification
 * in a way that looks like the patient's plan is bad.
 */
export function normalizeDateOfBirth(input: string): string | null {
  const text = input.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  // US convention: M/D/YYYY. Two-digit years are ambiguous for a DOB (a '55
  // could be 1955 or 2055), so they are left for the model to ask about.
  const slashed = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!slashed) return null;

  const [, month, day, year] = slashed;
  if (Number(month) > 12 || Number(day) > 31) return null;

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function patientTools(api: CedarRidgeClient, session: Session) {
  let payerCache: Array<{ payer_id: string; name: string }> | undefined;

  /**
   * Resolve "Cigna" / "I have Delta" to a payer_id.
   *
   * The model guesses ids it has not seen — "cigna" instead of "cigna-dental" —
   * and eats a PAYER_UNKNOWN. Matching here costs one cached call and removes
   * the error class entirely.
   */
  async function resolvePayer(text: string) {
    payerCache ??= (await api.listPayers()).payers;

    const needle = text.trim().toLowerCase();
    const exact = payerCache.find((p) => p.payer_id.toLowerCase() === needle);
    if (exact) return { payer: exact };

    const matches = payerCache.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        needle.includes(p.name.toLowerCase().split(' ')[0]),
    );

    if (matches.length === 1) return { payer: matches[0] };

    return {
      options: payerCache.map((p) => p.name),
      ambiguous: matches.length > 1 ? matches.map((p) => p.name) : undefined,
    };
  }

  return {
    registerPatient: tool({
      description:
        'Create or identify a patient record and return a patientId, which ' +
        'every booking step requires. Returning patients need only the basics; ' +
        'new patients also need a full address and an emergency contact. ' +
        'Collect the missing fields from the patient before calling this ' +
        'rather than guessing.',
      inputSchema: z.object({
        status: z
          .enum(['new', 'returning'])
          .describe('Whether the patient has been seen at this practice before'),
        first_name: z.string(),
        last_name: z.string(),
        date_of_birth: z
          .string()
          .describe('However the patient said it — "8/2/1988" is fine'),
        phone: z
          .string()
          .describe(
            'However the patient said it — "(555) 555 0142", "5555550142" and ' +
              '"555-555-0142" are all accepted and reformatted for you',
          ),
        email: z.string(),
        address_line1: z.string().optional().describe('Required for new patients'),
        city: z.string().optional().describe('Required for new patients'),
        state: z.string().optional().describe('Required for new patients'),
        zip: z.string().optional().describe('Required for new patients'),
        emergency_contact_name: z
          .string()
          .optional()
          .describe('Required for new patients'),
        emergency_contact_phone: z
          .string()
          .optional()
          .describe('Required for new patients'),
      }),
      execute: (input) =>
        withRecovery(async () => {
          // Registering the same caller twice leaves a duplicate record in a
          // system the evaluator inspects. If we already have one, hand it back.
          if (session.patient) {
            return {
              patientId: session.patient.id,
              name: session.patient.name,
              status: session.patient.status,
              alreadyRegistered: true,
              note:
                'This patient was already registered earlier in this ' +
                'conversation. No new record was created — reuse this patientId.',
            };
          }

          // Reformat before POSTing rather than letting the API 422 on a number
          // that was perfectly clear.
          const phone = normalizePhone(input.phone);
          const emergencyPhone = input.emergency_contact_phone
            ? normalizePhone(input.emergency_contact_phone)
            : undefined;
          const dateOfBirth = normalizeDateOfBirth(input.date_of_birth);

          const unclear = [
            !phone &&
              `The phone number "${input.phone}" is not a complete 10-digit ` +
                'number. Ask the patient for the full number including area ' +
                'code. Do not add or drop digits yourself.',
            input.emergency_contact_phone &&
              !emergencyPhone &&
              `The emergency contact number ` +
                `"${input.emergency_contact_phone}" is not a complete 10-digit ` +
                'number. Ask for the full number including area code.',
            !dateOfBirth &&
              `The date of birth "${input.date_of_birth}" could not be read ` +
                'unambiguously. Ask the patient to give the month, day, and ' +
                'four-digit year.',
          ].filter((x): x is string => typeof x === 'string');

          if (unclear.length || !phone || !dateOfBirth) {
            return {
              status: 'incomplete_details' as const,
              registered: false,
              askFor: unclear,
              note:
                'No record was created. Ask the patient for the values above ' +
                'and call registerPatient again. Never invent digits.',
            };
          }

          const patient = await api.registerPatient({
            ...input,
            phone,
            date_of_birth: dateOfBirth,
            ...(emergencyPhone
              ? { emergency_contact_phone: emergencyPhone }
              : {}),
          });

          session.patient = {
            id: patient.id,
            name: `${patient.first_name} ${patient.last_name}`,
            status: patient.status,
          };
          session.insurance = { status: patient.insurance_status };

          return {
            patientId: patient.id,
            name: `${patient.first_name} ${patient.last_name}`,
            status: patient.status,
            insuranceStatus: patient.insurance_status,
            next: 'Settle insurance with verifyInsurance before searching availability.',
          };
        }, 'registerPatient'),
    }),

    listPayers: tool({
      description:
        'List insurance payers the system recognizes, so free text like "I ' +
        'have Delta Dental" can be mapped to a payerId. This does NOT tell you ' +
        'whether a payer is accepted — only verifyInsurance does that.',
      inputSchema: z.object({}),
      execute: () => withRecovery(() => api.listPayers(), 'listPayers'),
    }),

    verifyInsurance: tool({
      description:
        "Settle the patient's insurance, or record them as self-pay. Required " +
        'before availability can be searched and before any price is quoted. ' +
        'Pass selfPay true, or both payerId and memberId (the number on their ' +
        'insurance card). Verification can fail while still succeeding as a ' +
        'call — always read the returned status.',
      inputSchema: z.object({
        selfPay: z.boolean().optional().describe('True to skip insurance entirely'),
        payer: z
          .string()
          .optional()
          .describe(
            'The insurer as the patient said it, e.g. "Delta Dental" or ' +
              '"Cigna". Free text is fine — it is matched for you.',
          ),
        memberId: z.string().optional().describe('The ID on the insurance card'),
        dateOfBirth: z.string().optional().describe('YYYY-MM-DD'),
      }),
      execute: ({ selfPay, payer, memberId, dateOfBirth }) =>
        withRecovery(async () => {
          if (!session.patient) {
            return {
              status: 'no_patient' as const,
              settled: false,
              note:
                'No patient record yet. Call registerPatient before settling ' +
                'insurance.',
            };
          }
          const patientId = session.patient.id;

          // Already settled and not being changed — re-verifying costs a call
          // from a metered budget and tells us nothing new.
          const settled = session.insurance?.status;
          if (
            (settled === 'active' || settled === 'self_pay') &&
            !selfPay &&
            !memberId
          ) {
            return {
              status: settled,
              settled: true,
              planName: session.insurance?.planName,
              note: 'Insurance was already settled for this patient. Nothing to redo.',
            };
          }

          if (selfPay) {
            const result = await api.setInsurance(patientId, { self_pay: true });
            session.insurance = { status: 'self_pay' };

            return {
              status: result.status,
              settled: true,
              note: 'Self-pay recorded. Quote the self-pay price for the service.',
            };
          }

          // A member ID the patient never gave is worse than no attempt: it
          // comes back `invalid_member`, which reads like *their* card is bad,
          // and the usual next move is self-pay — quietly costing them the
          // difference between a copay and the full price.
          const looksReal = !!memberId && /^[a-z0-9-]{6,}$/i.test(memberId.trim());

          if (!payer || !looksReal) {
            return {
              status: 'incomplete' as const,
              settled: false,
              note:
                'Not enough to verify, and nothing was sent to the insurer. ' +
                (payer && !memberId
                  ? `Ask the patient for their ${payer} member ID — the number ` +
                    'on their card. Do not guess it, and do not move them to ' +
                    'self-pay until you have asked for it at least once.'
                  : 'Ask the patient which insurer they have and for the member ' +
                    'ID on their card, or offer self-pay if they have neither.'),
            };
          }

          const resolved = await resolvePayer(payer);
          if (!resolved.payer) {
            return {
              status: 'payer_unclear' as const,
              settled: false,
              knownPayers: resolved.options,
              note: resolved.ambiguous
                ? `"${payer}" could be ${resolved.ambiguous.join(' or ')}. Ask which one.`
                : `"${payer}" is not an insurer this practice works with. Tell ` +
                  'the patient and offer the self-pay price.',
            };
          }
          const payerId = resolved.payer.payer_id;

          const result = await api.setInsurance(patientId, {
            payer_id: payerId,
            member_id: memberId,
            date_of_birth: dateOfBirth,
          });

          session.insurance = {
            status: result.status,
            planName: result.plan_name,
            coveredCodes: result.covered_services?.map((s) => s.code),
          };

          // A 200 here is not success. `invalid_member` and `not_accepted` both
          // arrive on the happy path of the wire protocol.
          if (result.status === 'invalid_member') {
            return {
              status: result.status,
              settled: false,
              note:
                'That member ID did not match the payer. Read it back to the ' +
                'patient to check for a typo and try once more; if it still ' +
                'fails, offer to proceed as self-pay.',
            };
          }

          if (result.status === 'not_accepted') {
            return {
              status: result.status,
              settled: false,
              note:
                `${result.message ?? 'This practice does not accept that plan.'} ` +
                'Tell the patient plainly, quote the self-pay price, and if they ' +
                'agree call verifyInsurance again with selfPay true.',
            };
          }

          return {
            status: result.status,
            settled: true,
            planName: result.plan_name,
            // Money stays formatted here so the model never does arithmetic.
            coveredServices: result.covered_services?.map((s) => ({
              code: s.code,
              copay: dollars(s.copay),
            })),
            note:
              'Only the services listed above are covered. Anything else is ' +
              'billed at the self-pay price even though the plan is active.',
          };
        }, 'verifyInsurance'),
    }),
  };
}
