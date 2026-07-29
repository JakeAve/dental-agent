/**
 * End-to-end smoke test against the Cedar Ridge sandbox.
 *
 *   npm run smoke
 *
 * Walks the full booking sequence and cancels at the end, so it leaves no
 * stray appointment behind. Verifies that every zod schema in lib/cedar-ridge.ts
 * matches what the API actually returns.
 */
import { envClient } from '../lib/cedar-ridge';

const log = (label: string, value: unknown) =>
  console.log(`\n▸ ${label}\n`, JSON.stringify(value, null, 2).slice(0, 700));

async function main() {
  const api = envClient();

  const practice = await api.getPractice();
  log('practice', practice);

  const { services } = await api.listServices();
  log(`services (${services.length})`, services.map((s) => `${s.code} ${s.name}`));

  const { payers } = await api.listPayers();
  log(`payers (${payers.length})`, payers.slice(0, 5));

  const faqs = await api.searchFaqs({ q: 'parking', page_size: 2 });
  log('faq search "parking"', faqs.faqs.map((f) => f.question));

  const patient = await api.registerPatient({
    status: 'returning',
    first_name: 'Smoke',
    last_name: 'Test',
    date_of_birth: '1990-01-01',
    phone: '555-000-1111',
    email: 'smoke.test@example.com',
  });
  log('registerPatient', patient);

  const insurance = await api.setInsurance(patient.id, { self_pay: true });
  log('setInsurance (self-pay)', insurance);

  const service = services[0].code;
  const availability = await api.getAvailability({
    service,
    patient_id: patient.id,
  });
  log(
    `availability for ${service}`,
    availability.availability.slice(0, 3).map((s) => `${s.starts_at} — ${s.provider.name}`),
  );

  if (availability.availability.length === 0) {
    console.log('\n⚠️  No slots available — stopping before hold/book.');
    return;
  }

  const hold = await api.holdSlot({
    slot_id: availability.availability[0].slot_id,
    patient_id: patient.id,
    service,
  });
  log('holdSlot', hold);

  const appt = await api.confirmAppointment({
    hold_id: hold.hold_id,
    notes: 'automated smoke test',
  });
  log('confirmAppointment', appt);

  const cancelled = await api.cancelAppointment(appt.id);
  log('cancelAppointment', { id: cancelled.id, status: cancelled.status });

  console.log('\n✅ Full booking sequence passed, schemas validated.');
}

main().catch((err) => {
  console.error('\n❌ Smoke test failed:\n', err);
  process.exit(1);
});
