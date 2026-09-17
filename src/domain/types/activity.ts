import type { ActivityId, IsoDateTime, JobId, UserId } from './common';

/**
 * Audit events. The demo records these into the same repository the UI reads,
 * which keeps the write path honest: nothing appears on a timeline unless the
 * business logic actually emitted it.
 */
export type ActivityEventType =
  | 'job_created'
  | 'job_assigned'
  | 'job_accepted'
  | 'site_location_sent'
  | 'site_location_declined'
  | 'site_location_failed'
  | 'technician_added'
  | 'technician_removed'
  | 'note_added'
  | 'photo_uploaded'
  | 'labour_added'
  | 'travel_added'
  | 'part_added'
  | 'checklist_completed'
  | 'moved_to_awaiting_spares'
  | 'returned_to_in_progress'
  | 'completion_started'
  | 'customer_signed'
  | 'pdf_generated'
  | 'job_submitted'
  | 'master_amended_after_signature'
  | 'job_closed'
  | 'document_viewed'
  // Record administration. These carry no job id: they describe changes to the
  // customer, machine, user, library and checklist registers.
  | 'customer_created'
  | 'customer_updated'
  | 'site_created'
  | 'site_updated'
  | 'contact_created'
  | 'contact_updated'
  | 'machine_created'
  | 'machine_approved'
  | 'machine_updated'
  | 'user_created'
  | 'user_updated'
  | 'user_disabled'
  | 'user_reactivated'
  | 'password_reset_sent'
  | 'document_added'
  | 'document_updated'
  | 'document_versioned'
  | 'document_approved'
  | 'document_archived'
  | 'checklist_template_created'
  | 'checklist_template_updated'
  | 'checklist_template_versioned'
  | 'checklist_template_archived'
  // Availability, messaging, transfer and the two ways a job can leave the
  // active workflow.
  | 'availability_created'
  | 'availability_updated'
  | 'availability_cancelled'
  | 'message_sent'
  | 'message_actioned'
  | 'job_transferred_to_open'
  | 'job_transferred_to_technician'
  | 'job_cancelled'
  | 'job_deleted';

export interface ActivityEvent {
  readonly id: ActivityId;
  readonly jobId: JobId | null;
  readonly type: ActivityEventType;
  /** Human-readable summary, resolved at write time so the timeline is stable. */
  readonly summary: string;
  readonly detail: string;
  readonly actorId: UserId;
  readonly occurredAt: IsoDateTime;
}
