import { createClient, type Appointment } from '../../lib/cedar-ridge';
import { apiConfig } from './run';

/**
 * Ground truth, read straight from the dental API.
 *
 * The whole point of the suite: an agent that *says* "you're booked for Tuesday
 * at 2" passes any assertion made on its prose, whether or not it ever called
 * confirmAppointment. So outcome assertions come from here instead.
 */

export const fetchAppointment = (id: string): Promise<Appointment> =>
  createClient(apiConfig()).getAppointment(id);

export async function fetchAppointments(ids: string[]): Promise<Appointment[]> {
  const api = createClient(apiConfig());
  return Promise.all(ids.map((id) => api.getAppointment(id)));
}

/** Service codes, for asserting the agent picked the right one (S30 triage). */
export const SERVICE = {
  exam: 'D0150',
  cleaning: 'D1110',
  filling: 'D2391',
  crown: 'D2740',
  extraction: 'D7140',
  emergencyExam: 'D9110',
} as const;
