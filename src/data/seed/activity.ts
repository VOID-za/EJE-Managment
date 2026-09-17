import { asActivityId, asJobId, asUserId, type ActivityEvent } from '@/domain';
import { timeOffset } from './reference';

const event = (
  id: string,
  jobNumber: string | null,
  type: ActivityEvent['type'],
  summary: string,
  detail: string,
  actor: string,
  days: number,
  hours: number,
  minutes = 0,
): ActivityEvent => ({
  id: asActivityId(id),
  jobId: jobNumber === null ? null : asJobId(`job-${jobNumber.toLowerCase()}`),
  type,
  summary,
  detail,
  actorId: asUserId(actor),
  occurredAt: timeOffset(days, hours, minutes),
});

/** Seeded audit trail. New events are appended by the application at runtime. */
export const seedActivity: readonly ActivityEvent[] = [
  event('act-1048-1', 'EJE-1048', 'job_created', 'Job created', 'Breakdown job logged after a telephone call from the customer.', 'user-master-elmarie', 0, 6, 40),
  event('act-1048-2', 'EJE-1048', 'job_assigned', 'Job assigned to Sipho Mahlangu', 'Assigned as primary technician, with André Steyn assisting.', 'user-master-elmarie', 0, 6, 45),
  event('act-1048-3', 'EJE-1048', 'note_added', 'Internal note added', 'Spare drive fan is in the Isando stores.', 'user-master-johan', 0, 6, 55),

  event('act-1061-1', 'EJE-1061', 'job_created', 'Job created', 'Tool changer fault reported by the workshop.', 'user-master-elmarie', 0, 7, 20),
  event('act-1061-2', 'EJE-1061', 'job_accepted', 'Job accepted', 'Acceptance moved the job to In Progress.', 'user-tech-riaan', 0, 7, 45),
  event('act-1061-3', 'EJE-1061', 'travel_added', 'Travel captured: 52 km', 'Isando to Benoni return.', 'user-tech-riaan', 0, 8, 30),
  event('act-1061-4', 'EJE-1061', 'labour_added', 'Labour captured: 2.00 hrs normal time', 'Tool changer fault finding.', 'user-tech-riaan', 0, 11, 0),

  event('act-1053-1', 'EJE-1053', 'job_created', 'Job created', 'Scheduled service raised from the maintenance agreement.', 'user-master-denise', -5, 9, 0),
  event('act-1053-2', 'EJE-1053', 'job_accepted', 'Job accepted', 'Acceptance moved the job to In Progress.', 'user-tech-thabo', 0, 7, 50),
  event('act-1053-3', 'EJE-1053', 'completion_started', 'Job moved to Completion', 'Technician started the completion write-up.', 'user-tech-thabo', 0, 13, 20),

  event('act-1052-1', 'EJE-1052', 'job_created', 'Job created', 'Urgent breakdown reported by the facilities engineer.', 'user-master-elmarie', -2, 7, 5),
  event('act-1052-2', 'EJE-1052', 'job_accepted', 'Job accepted', 'Acceptance moved the job to In Progress.', 'user-tech-naledi', -2, 7, 40),
  event('act-1052-3', 'EJE-1052', 'moved_to_awaiting_spares', 'Job moved to Awaiting Spares', 'Encoder assembly quoted to the customer. Awaiting purchase order.', 'user-tech-naledi', -2, 16, 10),

  event('act-1051-1', 'EJE-1051', 'job_created', 'Job created', 'Drive booked into the Isando workshop.', 'user-master-johan', -9, 8, 15),
  event('act-1051-2', 'EJE-1051', 'job_accepted', 'Job accepted', 'Acceptance moved the job to In Progress.', 'user-tech-deon', -4, 8, 40),
  event('act-1051-3', 'EJE-1051', 'moved_to_awaiting_spares', 'Job moved to Awaiting Spares', 'Replacement IGBT module on back-order.', 'user-tech-deon', -4, 15, 30),

  event('act-1054-1', 'EJE-1054', 'job_created', 'Job created', 'Breakdown reported by the workshop manager.', 'user-master-elmarie', -1, 6, 55),
  event('act-1054-2', 'EJE-1054', 'job_accepted', 'Job accepted', 'Acceptance moved the job to In Progress.', 'user-tech-lerato', -1, 7, 20),
  event('act-1054-3', 'EJE-1054', 'part_added', 'Part captured: TRF-400-110', 'Control transformer 400/110V 500VA, quantity 1.', 'user-tech-lerato', -1, 15, 5),
  event('act-1054-4', 'EJE-1054', 'customer_signed', 'Customer signed the job card', 'Signed by Sanele Zulu.', 'user-tech-lerato', -1, 15, 45),
  event('act-1054-5', 'EJE-1054', 'pdf_generated', 'Job card document generated', 'Simulated PDF generated for review.', 'user-tech-lerato', -1, 15, 46),

  event('act-1055-1', 'EJE-1055', 'customer_signed', 'Customer signed the job card', 'Signed by Anita Ferreira.', 'user-tech-riaan', -3, 14, 15),
  event('act-1055-2', 'EJE-1055', 'job_submitted', 'Job submitted', 'Job card submitted and queued for delivery to the customer.', 'user-tech-riaan', -3, 14, 25),

  event('act-1056-1', 'EJE-1056', 'job_submitted', 'Job submitted', 'Job card submitted and closed.', 'user-tech-sipho', -21, 12, 20),
  event('act-1056-2', 'EJE-1056', 'job_closed', 'Job closed', 'Signed job card delivered to the customer.', 'user-master-elmarie', -21, 12, 20),

  event('act-1050-1', 'EJE-1050', 'job_created', 'Job created', 'Installation raised against purchase order PO-44920.', 'user-master-denise', -8, 11, 30),
  event('act-1050-2', 'EJE-1050', 'job_assigned', 'Job assigned to Francois du Toit', 'Assigned as primary technician with Thabo Nkosi assisting.', 'user-master-denise', -8, 11, 35),

  event('act-lib-1', null, 'document_viewed', 'Technical Library document viewed', 'Leadwell V-40 Electrical Diagram opened.', 'user-tech-sipho', 0, 9, 10),
  event('act-cust-1', null, 'customer_updated', 'Customer updated', 'Payment terms updated on ABC Engineering (Pty) Ltd.', 'user-master-elmarie', -64, 11, 40),
  event('act-mach-1', null, 'machine_updated', 'Machine record updated', 'Notes updated on Leadwell MCV-760 (LW-MCV760-51188).', 'user-master-johan', -30, 10, 0),
];
