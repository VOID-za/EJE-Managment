-- Records that cannot be rewritten.
--
-- The application layer already refuses these edits — no operation updates a
-- pricing snapshot, and `loadFinalDocumentFile` never re-renders an issued
-- document. These triggers are the second line: a mistaken migration, a
-- well-meant support query, or a future code path that forgets cannot destroy a
-- historical record. A job card the customer holds has to stay the job card the
-- customer holds, and the database is the only place that can guarantee it.
--
-- Three shapes, because the rules genuinely differ:
--
--   APPEND-ONLY   rows may be inserted and read, never updated or deleted.
--   WRITE-ONCE    the same, for records that describe a single moment.
--   WRITE-ONCE-   most columns frozen at insert; a named few may be filled in
--   WITH-RESOLUTION  exactly once, from null to a value.

-- ---------------------------------------------------------------------------
-- Generic guards
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% is an immutable historical record; % is not permitted. Correct it by adding a new record.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- WRITE-ONCE: the customer's acceptance, the frozen price, the issued document
-- ---------------------------------------------------------------------------

CREATE TRIGGER job_signatures_immutable
  BEFORE UPDATE OR DELETE ON job_signatures
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER pricing_snapshots_immutable
  BEFORE UPDATE OR DELETE ON pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER pricing_snapshot_lines_immutable
  BEFORE UPDATE OR DELETE ON pricing_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER final_documents_immutable
  BEFORE UPDATE OR DELETE ON final_documents
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- APPEND-ONLY: the trail, the handovers, the attempts, who was on the job
-- ---------------------------------------------------------------------------

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER machine_approvals_append_only
  BEFORE DELETE ON machine_approvals
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER job_transfers_append_only
  BEFORE UPDATE OR DELETE ON job_transfers
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER chat_messages_append_only
  BEFORE DELETE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Signature refusals: frozen, except for the office's resolution
-- ---------------------------------------------------------------------------
--
-- Attempt 1 is never overwritten. What the technician recorded — the reason,
-- who took it, when — is fixed at insert. The office may fill in the resolution
-- once, and only once: null to a value, never value to a different value.

CREATE OR REPLACE FUNCTION signature_refusals_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A signature refusal is a historical record and cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.job_id     IS DISTINCT FROM OLD.job_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.reason  IS DISTINCT FROM OLD.reason
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION
      'What was recorded when the customer refused cannot be changed. Correct the job card and resubmit it instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.resolved_at IS NOT NULL
     AND (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
          OR NEW.resolution IS DISTINCT FROM OLD.resolution
          OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by) THEN
    RAISE EXCEPTION 'This refusal has already been resolved; its resolution cannot be rewritten.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER signature_refusals_guard
  BEFORE UPDATE OR DELETE ON signature_refusals
  FOR EACH ROW EXECUTE FUNCTION signature_refusals_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Job participation: append-only, closed once
-- ---------------------------------------------------------------------------
--
-- This is what a technician's historical visibility is read from, so a
-- reassignment must not be able to erase it. A row may be closed by setting
-- `until`; nothing else may change, and nothing may be removed.

CREATE OR REPLACE FUNCTION job_participants_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Job participation is historical and cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role    IS DISTINCT FROM OLD.role
     OR NEW.since   IS DISTINCT FROM OLD.since THEN
    RAISE EXCEPTION 'Who was on a job, in which role and from when, cannot be rewritten.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.until IS NOT NULL AND NEW.until IS DISTINCT FROM OLD.until THEN
    RAISE EXCEPTION 'This participation has already ended.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER job_participants_guard
  BEFORE UPDATE OR DELETE ON job_participants
  FOR EACH ROW EXECUTE FUNCTION job_participants_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Delivery attempts: append-only, except for the provider's later verdict
-- ---------------------------------------------------------------------------
--
-- An attempt is a thing that happened. The provider may tell us afterwards what
-- became of it — accepted, delivered, bounced — and that verdict is written onto
-- the attempt it belongs to. Nothing about the attempt itself may change.

CREATE OR REPLACE FUNCTION delivery_attempts_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A delivery attempt is a historical record and cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.recipient IS DISTINCT FROM OLD.recipient
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.attempted_at IS DISTINCT FROM OLD.attempted_at THEN
    RAISE EXCEPTION 'What was attempted, to whom and when cannot be rewritten.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER delivery_attempts_guard
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Checklists: a completed instance and a used version are frozen
-- ---------------------------------------------------------------------------
--
-- A completed checklist must for ever render the wording the customer actually
-- saw. Editing a version a job has answered against would silently rewrite
-- history on every job card that used it.

CREATE OR REPLACE FUNCTION checklist_instances_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A completed checklist is part of the job card and cannot be deleted.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This checklist has been completed and cannot be changed.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER checklist_instances_guard
  BEFORE UPDATE OR DELETE ON checklist_instances
  FOR EACH ROW EXECUTE FUNCTION checklist_instances_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION checklist_answers_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  completed timestamptz;
BEGIN
  SELECT i.completed_at INTO completed
    FROM checklist_instances i
   WHERE i.id = COALESCE(NEW.instance_id, OLD.instance_id);

  IF completed IS NOT NULL THEN
    RAISE EXCEPTION 'This checklist has been completed; its answers cannot be changed.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint

CREATE TRIGGER checklist_answers_guard
  BEFORE UPDATE OR DELETE ON checklist_answers
  FOR EACH ROW EXECUTE FUNCTION checklist_answers_guard();
--> statement-breakpoint

-- A version nobody has answered against is a draft and may be edited freely.
-- One that a job has used is the wording on that job card, for ever.
CREATE OR REPLACE FUNCTION checklist_version_in_use_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_id uuid;
  used boolean;
BEGIN
  version_id := COALESCE(NEW.id, OLD.id);

  SELECT EXISTS (SELECT 1 FROM checklist_instances i WHERE i.version_id = version_id)
    INTO used;

  IF NOT used THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'This checklist version has been used on a job and cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Archiving a used version is legitimate: it withdraws it from new jobs
  -- without touching the jobs that already answered against it.
  IF NEW.version IS DISTINCT FROM OLD.version
     OR NEW.checklist_id IS DISTINCT FROM OLD.checklist_id
     OR NEW.source_document IS DISTINCT FROM OLD.source_document THEN
    RAISE EXCEPTION
      'This checklist version has been used on a job. Start a new version instead of editing it.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER checklist_versions_in_use_guard
  BEFORE UPDATE OR DELETE ON checklist_versions
  FOR EACH ROW EXECUTE FUNCTION checklist_version_in_use_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION checklist_questions_in_use_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  used boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM checklist_instances i
      JOIN checklist_sections s ON s.version_id = i.version_id
     WHERE s.id = COALESCE(NEW.section_id, OLD.section_id)
  ) INTO used;

  IF used THEN
    RAISE EXCEPTION
      'This question belongs to a checklist version that has been used on a job. Start a new version instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint

CREATE TRIGGER checklist_questions_in_use_guard
  BEFORE UPDATE OR DELETE ON checklist_questions
  FOR EACH ROW EXECUTE FUNCTION checklist_questions_in_use_guard();
