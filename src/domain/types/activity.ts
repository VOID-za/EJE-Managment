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
  | 'customer_updated'
  | 'machine_updated';

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
