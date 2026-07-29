/**
 * Two vocabularies for the same ten tools.
 *
 * Patients get a plain-language status line — they should never see a tool
 * name. The inspector gets the real name, because that is the whole point of
 * the inspector.
 */

export const TOOL_LABELS: Record<string, string> = {
  getPracticeInfo: 'Looking up office details',
  listServices: 'Checking what we offer',
  searchFaqs: 'Checking our FAQs',
  registerPatient: 'Setting up your record',
  listPayers: 'Looking up insurance plans',
  verifyInsurance: 'Verifying your insurance',
  findAvailability: 'Checking availability',
  holdSlot: 'Holding that time for you',
  confirmAppointment: 'Booking your appointment',
  getAppointment: 'Finding your appointment',
  cancelAppointment: 'Cancelling',
};

/** `tool-findAvailability` → `findAvailability`. */
export const toolName = (partType: string) => partType.replace(/^tool-/, '');

/** The stage of the booking sequence a tool belongs to, for colour-coding. */
export const TOOL_STAGE: Record<string, 'lookup' | 'patient' | 'booking'> = {
  getPracticeInfo: 'lookup',
  listServices: 'lookup',
  searchFaqs: 'lookup',
  listPayers: 'lookup',
  registerPatient: 'patient',
  verifyInsurance: 'patient',
  findAvailability: 'booking',
  holdSlot: 'booking',
  confirmAppointment: 'booking',
  getAppointment: 'booking',
  cancelAppointment: 'booking',
};
