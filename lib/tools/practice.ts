import { tool } from 'ai';
import { z } from 'zod';
import type { CedarRidgeClient } from '../cedar-ridge';
import { FAQ_PAGE_SIZE } from '../config';
import { withRecovery } from './errors';

/** Public information — no patient identity needed for any of these. */
export function practiceTools(api: CedarRidgeClient) {
  return {
    getPracticeInfo: tool({
      description:
        'Get the office name, address, phone number, timezone, and business hours.',
      inputSchema: z.object({}),
      execute: () => withRecovery(() => api.getPractice()),
    }),

    listServices: tool({
      description:
        'List the services the practice offers, with codes, durations, and ' +
        'self-pay prices. Call this to map what the patient describes ' +
        '("cleaning", "my tooth hurts") onto a service code before checking ' +
        'availability. Read each description carefully — treatment services ' +
        'assume a dentist has already recommended them.',
      inputSchema: z.object({}),
      execute: () =>
        withRecovery(async () => {
          const { services } = await api.listServices();

          return services.map((s) => ({
            code: s.code,
            name: s.name,
            description: s.description,
            providerType: s.provider_type,
            durationMinutes: s.duration_minutes,
            selfPayPrice: `$${(s.self_pay_price / 100).toFixed(2)}`,
          }));
        }),
    }),

    searchFaqs: tool({
      description:
        "Search the office's FAQ knowledge base for questions about policies, " +
        'parking, what to bring, visit preparation, and similar. Use this ' +
        'before answering any general question about the practice — prefer a ' +
        'real FAQ answer over your own knowledge.',
      inputSchema: z.object({
        q: z.string().describe("The patient's question, in their own words"),
      }),
      execute: ({ q }) =>
        withRecovery(async () => {
          const { faqs } = await api.searchFaqs({ q, page_size: FAQ_PAGE_SIZE });

          if (faqs.length === 0) {
            return {
              faqs: [],
              message: 'No FAQ matches. Offer to have the front desk answer this.',
            };
          }

          return {
            faqs: faqs.map((f) => ({ question: f.question, answer: f.answer })),
          };
        }),
    }),
  };
}
