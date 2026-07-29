import { z } from 'zod';

/**
 * Typed client for the Cedar Ridge Dental Scheduling API (v1).
 *
 * Generated against the live OpenAPI spec at {baseUrl}/openapi.json.
 * This is the only file that knows about paths, auth, or wire format — tools in
 * lib/tools/ call these functions and nothing else.
 *
 * Credentials are per-client, not per-process: the evaluation protocol hands us
 * a fresh, run-scoped `base_url` and `api_key` in every turn request, and that
 * key is revoked before scoring. `envClient()` covers local dev and the smoke
 * script; the evaluation route builds a client per run instead.
 */

export type CedarRidgeConfig = {
  baseUrl: string;
  apiKey: string;
  /**
   * Aborts every request this client makes.
   *
   * The protocol requires background work to stop when a turn ends. Cancelling
   * the model loop alone is not enough: a tool call already in flight keeps
   * going, and each one spends from a run-scoped key with a published call
   * budget — so a turn we already gave up on would quietly bill the budget the
   * *next* turn needs. A client is built per turn, so a client-wide signal is
   * the right granularity.
   */
  signal?: AbortSignal;
};

/** Every error code the API documents, plus a catch-all for anything new. */
export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'PAYER_UNKNOWN'
  | 'INSURANCE_REQUIRED'
  | 'INVALID_SERVICE'
  | 'SLOT_TAKEN'
  | 'SLOT_UNAVAILABLE'
  | 'HOLD_ALREADY_USED'
  | 'HOLD_EXPIRED'
  | 'RATE_LIMITED'
  | 'UNKNOWN';

/**
 * A failed API call, with the error envelope decoded.
 *
 * `message` is the API's own message, never the request URL or headers — the
 * key must never reach a log line or a model prompt.
 */
export class CedarRidgeError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CedarRidgeError';
  }
}

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

const KNOWN_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'UNAUTHORIZED',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'PAYER_UNKNOWN',
  'INSURANCE_REQUIRED',
  'INVALID_SERVICE',
  'SLOT_TAKEN',
  'SLOT_UNAVAILABLE',
  'HOLD_ALREADY_USED',
  'HOLD_EXPIRED',
  'RATE_LIMITED',
]);

function toError(status: number, body: string): CedarRidgeError {
  const parsed = errorEnvelope.safeParse(safeJson(body));

  if (!parsed.success) {
    return new CedarRidgeError(
      'UNKNOWN',
      `The scheduling system returned an unexpected ${status} response.`,
      status,
    );
  }

  const { code, message, details } = parsed.data.error;

  return new CedarRidgeError(
    (KNOWN_CODES.has(code) ? code : 'UNKNOWN') as ApiErrorCode,
    message,
    status,
    details ?? {},
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const query = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const practiceSchema = z.object({
  name: z.string(),
  address: z.object({
    line1: z.string(),
    city: z.string(),
    state: z.string(),
    zip: z.string(),
  }),
  phone: z.string(),
  timezone: z.string(),
  business_hours: z.object({
    days: z.string(),
    open: z.string(),
    close: z.string(),
  }),
});

const serviceSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  provider_type: z.string(),
  duration_minutes: z.object({
    new_patient: z.number(),
    returning_patient: z.number(),
  }),
  self_pay_price: z.number(),
});

const faqSchema = z.object({
  id: z.string(),
  category: z.string(),
  question: z.string(),
  answer: z.string(),
  tags: z.array(z.string()),
});

const patientSchema = z.object({
  id: z.string(),
  status: z.enum(['new', 'returning']),
  first_name: z.string(),
  last_name: z.string(),
  date_of_birth: z.string(),
  phone: z.string(),
  email: z.string(),
  insurance_status: z.enum([
    'unverified',
    'active',
    'not_accepted',
    'invalid_member',
    'self_pay',
  ]),
});

/**
 * Verification failure arrives as HTTP 200 with a status field — `invalid_member`
 * and `not_accepted` are not errors on the wire. Callers must branch on `status`.
 */
const insuranceResultSchema = z.object({
  status: z.enum(['active', 'not_accepted', 'invalid_member', 'self_pay']),
  plan_name: z.string().optional(),
  covered_services: z
    .array(z.object({ code: z.string(), copay: z.number() }))
    .optional(),
  message: z.string().optional(),
});

const slotSchema = z.object({
  slot_id: z.string(),
  starts_at: z.string(),
  duration_minutes: z.number(),
  provider: z.object({ id: z.string(), name: z.string(), type: z.string() }),
});

const appointmentSchema = z.object({
  id: z.string(),
  patient_id: z.string(),
  service_code: z.string(),
  service_name: z.string(),
  provider: z.object({ id: z.string(), name: z.string(), type: z.string() }),
  starts_at: z.string(),
  duration_minutes: z.number(),
  status: z.enum(['confirmed', 'cancelled']),
  notes: z.string().nullable().optional(),
  copay: z.number().optional(),
  self_pay_price: z.number().optional(),
  coverage: z.literal('not_covered').optional(),
});

export type Patient = z.infer<typeof patientSchema>;
export type Appointment = z.infer<typeof appointmentSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type InsuranceResult = z.infer<typeof insuranceResultSchema>;

export type RegisterPatientInput = {
  status: 'new' | 'returning';
  first_name: string;
  last_name: string;
  date_of_birth: string;
  phone: string;
  email: string;
  // New patients only.
  address_line1?: string;
  city?: string;
  state?: string;
  zip?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
};

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

export function createClient({ baseUrl, apiKey, signal }: CedarRidgeConfig) {
  if (!baseUrl || !apiKey) {
    throw new Error('createClient requires both baseUrl and apiKey');
  }

  const root = baseUrl.replace(/\/+$/, '');

  async function request<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    init?: RequestInit,
  ): Promise<z.infer<T>> {
    const res = await fetch(`${root}/api/v1${path}`, {
      ...init,
      // After the spread, deliberately: the turn's deadline outranks anything
      // a caller might pass per request.
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });

    const text = await res.text();

    if (!res.ok) throw toError(res.status, text);

    return schema.parse(text ? JSON.parse(text) : {});
  }

  return {
    getPractice: () => request('/practice', practiceSchema),

    listServices: () =>
      request('/services', z.object({ services: z.array(serviceSchema) })),

    listPayers: () =>
      request(
        '/payers',
        z.object({
          payers: z.array(z.object({ payer_id: z.string(), name: z.string() })),
        }),
      ),

    searchFaqs: (params: { q?: string; category?: string; page_size?: number }) =>
      request(
        `/faqs?${query(params)}`,
        z.object({ faqs: z.array(faqSchema), total_count: z.number() }),
      ),

    registerPatient: (body: RegisterPatientInput) =>
      request('/patients', patientSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    getPatient: (id: string) => request(`/patients/${id}`, patientSchema),

    setInsurance: (
      patientId: string,
      body:
        | { payer_id: string; member_id: string; date_of_birth?: string }
        | { self_pay: true },
    ) =>
      request(`/patients/${patientId}/insurance`, insuranceResultSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    getAvailability: (params: {
      service: string;
      patient_id: string;
      from?: string;
      to?: string;
      page?: number;
    }) =>
      request(
        `/availability?${query(params)}`,
        z.object({
          availability: z.array(slotSchema),
          page: z.number(),
          total_pages: z.number(),
        }),
      ),

    holdSlot: (body: { slot_id: string; patient_id: string; service: string }) =>
      request(
        '/holds',
        z.object({
          hold_id: z.string(),
          slot_id: z.string(),
          expires_at: z.string(),
          expires_in_seconds: z.number(),
        }),
        { method: 'POST', body: JSON.stringify(body) },
      ),

    confirmAppointment: (body: { hold_id: string; notes?: string }) =>
      request('/appointments', appointmentSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    getAppointment: (id: string) =>
      request(`/appointments/${id}`, appointmentSchema),

    cancelAppointment: (id: string) =>
      request(`/appointments/${id}`, appointmentSchema, { method: 'DELETE' }),
  };
}

export type CedarRidgeClient = ReturnType<typeof createClient>;

/** The developer sandbox from .env — local chat and `npm run smoke` only. */
export function envClient(): CedarRidgeClient {
  const baseUrl = process.env.CEDAR_RIDGE_BASE_URL;
  const apiKey = process.env.CEDAR_RIDGE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      'CEDAR_RIDGE_BASE_URL and CEDAR_RIDGE_API_KEY must both be set',
    );
  }

  return createClient({ baseUrl, apiKey });
}
