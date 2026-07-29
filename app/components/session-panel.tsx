'use client';

import { useEffect, useState } from 'react';
import type { SessionSnapshot } from '@/lib/session';

/**
 * The tool-side session, which is not the same thing as the transcript.
 *
 * These are the facts the tools themselves act on — the patient id they pass,
 * the slot refs `holdSlot` resolves against, the hold `confirmAppointment`
 * consumes. When the agent says something the API would refuse, this panel is
 * usually where the disagreement shows.
 */

export function SessionPanel({
  snapshot,
  receivedAt,
}: {
  snapshot: SessionSnapshot | null;
  receivedAt: number;
}) {
  if (!snapshot) {
    return (
      <p className="px-4 py-3 font-mono text-[11px] text-rail-dim">
        no session yet — send a message
      </p>
    );
  }

  const { patient, insurance, hold, booked, slotRefs, blocked } = snapshot;

  return (
    <dl className="divide-y divide-rail-rule/60">
      <Row label="patient">
        {patient ? (
          <span className="text-rail-text">
            {patient.name}
            <span className="text-rail-dim"> · {patient.status}</span>
            <br />
            <span className="text-rail-dim">{patient.id}</span>
          </span>
        ) : (
          <Absent>not registered</Absent>
        )}
      </Row>

      <Row label="insurance">
        {insurance ? (
          <span className="space-y-1">
            <StatusPill status={insurance.status} />
            {insurance.planName && (
              <span className="block text-rail-text">{insurance.planName}</span>
            )}
            {insurance.coveredCodes?.length ? (
              <span className="block text-rail-dim">
                covers {insurance.coveredCodes.join(' ')}
              </span>
            ) : null}
          </span>
        ) : (
          <Absent>unverified</Absent>
        )}
      </Row>

      <Row label="availability">
        {blocked ? (
          <span className="text-signal-warn">blocked — insurance unsettled</span>
        ) : (
          <span className="text-signal-ok">unblocked</span>
        )}
      </Row>

      <Row label="slot refs">
        {slotRefs.length ? (
          <ul className="space-y-0.5">
            {slotRefs.map((slot) => (
              <li key={slot.ref} className="text-rail-text">
                <span className="text-signal">{slot.ref}</span>{' '}
                <span className="text-rail-dim">{slot.startsAt}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Absent>none offered</Absent>
        )}
      </Row>

      <Row label="hold">
        {hold ? (
          <span>
            <Countdown from={hold.secondsLeft} receivedAt={receivedAt} />
            <span className="block text-rail-text">{hold.startsAt}</span>
            <span className="block text-rail-dim">{hold.service}</span>
          </span>
        ) : (
          <Absent>none</Absent>
        )}
      </Row>

      <Row label="booked">
        {booked.length ? (
          <ul className="space-y-1.5">
            {booked.map((appt) => (
              <li key={appt.id}>
                <span className="text-signal-ok">{appt.startsAt}</span>
                <span className="block text-rail-text">
                  {appt.service} · {appt.provider} · {appt.price}
                </span>
                <span className="block text-rail-dim">{appt.id}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Absent>none</Absent>
        )}
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-3 px-4 py-2.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-rail-dim">
        {label}
      </dt>
      <dd className="min-w-0 font-mono text-[11px] leading-relaxed break-words">
        {children}
      </dd>
    </div>
  );
}

const Absent = ({ children }: { children: React.ReactNode }) => (
  <span className="text-rail-dim/70">{children}</span>
);

const STATUS_COLOR: Record<string, string> = {
  active: 'text-signal-ok',
  self_pay: 'text-signal',
  unverified: 'text-rail-dim',
  not_accepted: 'text-signal-bad',
  invalid_member: 'text-signal-bad',
};

const StatusPill = ({ status }: { status: string }) => (
  <span className={`block font-medium ${STATUS_COLOR[status] ?? 'text-rail-text'}`}>
    {status}
  </span>
);

/**
 * Ticks locally from the snapshot rather than polling.
 *
 * A hold lasts five minutes and the agent is meant to confirm inside it. A
 * frozen number would hide the single most common failure — sitting on a hold
 * while collecting more details — so this counts down live.
 */
function Countdown({ from, receivedAt }: { from: number; receivedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = from - Math.floor((now - receivedAt) / 1000);

  if (left <= 0) {
    return <span className="block font-medium text-signal-bad">expired</span>;
  }

  const mins = Math.floor(left / 60);
  const secs = String(left % 60).padStart(2, '0');

  return (
    <span
      className={`block font-medium tabular-nums ${
        left < 60 ? 'text-signal-warn' : 'text-signal'
      }`}
    >
      {mins}:{secs} left
    </span>
  );
}
