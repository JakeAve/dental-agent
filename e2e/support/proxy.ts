import { createServer, type Server } from 'node:http';
import { record } from './ledger';

/**
 * A recording proxy for the dental API, handed to the agent as its `base_url`.
 *
 * Three jobs, none of which require knowing anything about how the agent is
 * built — it only ever sees an HTTP origin:
 *
 *   1. **Cleanup.** Captures the id of every appointment created, which is
 *      otherwise unrecoverable: the agent books internally and the protocol
 *      response never carries an id.
 *   2. **Ground truth.** Records the real call sequence, so a test can assert
 *      the agent actually booked rather than merely claiming to have.
 *   3. **A circuit breaker.** Refuses to forward a booking past a per-run cap,
 *      so a loop in the agent cannot fill the shared sandbox.
 */

export type RecordedCall = {
  method: string;
  /** Path with ids normalized to `:id`, for readable assertions. */
  route: string;
  path: string;
  status: number;
  durationMs: number;
  /** Epoch ms when the request *arrived*. Used to prove work stopped. */
  at: number;
};

export type Proxy = {
  origin: string;
  calls: RecordedCall[];
  appointmentIds: string[];
  patientIds: string[];
  /** Bookings the breaker refused. Non-empty means a test misbehaved. */
  refusedBookings: number;
  close: () => Promise<void>;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const normalize = (path: string) => path.split('?')[0].replace(UUID, ':id');

/**
 * Refusal body for a capped booking. Shaped as the API's own error envelope so
 * the agent handles it on a path it already has, instead of crashing on
 * something it has never seen.
 */
const CAP_REACHED = JSON.stringify({
  error: {
    code: 'SLOT_UNAVAILABLE',
    message: 'That time is no longer available.',
    details: {},
  },
});

export async function startProxy(options: {
  target: string;
  scenario: string;
  /** Hard ceiling on bookings this scenario may create. */
  maxBookings: number;
  /**
   * Artificial latency per call. Used to push a turn past its deadline without
   * touching product code, so the abort path can be exercised for real.
   */
  delayMs?: number;
}): Promise<Proxy> {
  const target = options.target.replace(/\/+$/, '');

  const calls: RecordedCall[] = [];
  const appointmentIds: string[] = [];
  const patientIds: string[] = [];
  let refusedBookings = 0;

  const server: Server = createServer((req, res) => {
    // A cancelled turn aborts its in-flight request, which lands here as an
    // ECONNRESET on the socket. That is the abort working, not a fault — but
    // without listeners Node raises it as an unhandled rejection and the test
    // runner reports a passing suite as suspect.
    req.on('error', () => {});
    res.on('error', () => {});

    void (async () => {
      const started = Date.now();
      const path = req.url ?? '/';
      const method = req.method ?? 'GET';

      // Body first, then latency: delaying before draining the request stream
      // means an abort arrives while the body is still unread, which throws
      // here rather than at the point the delay is meant to simulate.
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      if (options.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }

      const isBooking = method === 'POST' && normalize(path) === '/api/v1/appointments';

      // Breaker: never let a runaway agent create unbounded appointments in a
      // shared, persistent sandbox. Refuse locally — the call never leaves here.
      if (isBooking && appointmentIds.length >= options.maxBookings) {
        refusedBookings += 1;
        calls.push({
          method,
          route: normalize(path),
          path,
          status: 409,
          durationMs: 0,
          at: started,
        });
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(CAP_REACHED);
        return;
      }

      // Forward verbatim. Hop-by-hop headers and the original host would
      // confuse the upstream, so they are dropped.
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (['host', 'connection', 'content-length'].includes(k.toLowerCase())) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }

      try {
        const upstream = await fetch(`${target}${path}`, {
          method,
          headers,
          body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        });

        const text = await upstream.text();

        calls.push({
          method,
          route: normalize(path),
          path,
          status: upstream.status,
          durationMs: Date.now() - started,
          at: started,
        });

        // Capture ids on the way back. Written to the durable ledger first, so
        // a crash immediately after this line still leaves a cancellable id.
        if (upstream.ok && text) {
          try {
            const json = JSON.parse(text) as { id?: string };
            const route = normalize(path);

            if (isBooking && json.id) {
              appointmentIds.push(json.id);
              record({ kind: 'appointment', id: json.id, scenario: options.scenario });
            } else if (method === 'POST' && route === '/api/v1/patients' && json.id) {
              patientIds.push(json.id);
              record({ kind: 'patient', id: json.id, scenario: options.scenario });
            }
          } catch {
            // Not JSON — nothing to capture, and not this proxy's problem.
          }
        }

        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        res.end(text);
      } catch (err) {
        calls.push({
          method,
          route: normalize(path),
          path,
          status: 599,
          durationMs: Date.now() - started,
          at: started,
        });
        // The socket may already be gone if this was an abort; writing to it
        // would throw a second time.
        if (!res.writableEnded) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'UNKNOWN',
                message: err instanceof Error ? err.message : 'proxy failure',
                details: {},
              },
            }),
          );
        }
      }
    })().catch(() => {
      // Reaching here means the client vanished mid-request. Nothing to report:
      // the call is already recorded, and the test asserts on arrival times.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('proxy failed to bind a port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    appointmentIds,
    patientIds,
    get refusedBookings() {
      return refusedBookings;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
