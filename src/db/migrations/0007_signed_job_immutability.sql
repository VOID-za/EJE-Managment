-- A customer-signed job card is legally final. MASTER SCOPE CR-01 / IMMUT-1…7.
--
-- The application already refuses these changes — `assertEditable` asks
-- `finalizedRefusal` before any of the sixteen job mutations runs. This is the
-- second line, and it exists for the same reason `0002_immutability.sql` does:
-- a mistaken migration, a well-meant support query or a future code path that
-- forgets cannot be allowed to alter what a customer signed for.
--
-- WHAT 0002 ALREADY PROTECTS, and this deliberately does not repeat: the
-- signature itself, the pricing snapshot and its lines, the issued document,
-- the audit trail, the checklist versions and answers, transfers, refusals.
--
-- WHAT WAS LEFT UNGUARDED, and is the whole subject of this migration: the
-- evidence ON the job card. Labour, travel, parts, media, notes and the
-- completion write-up had no protection at any layer, and those are exactly
-- what IMMUT-7 names.
--
-- THE RULE IS NOT "AFTER A STATUS", IT IS "AFTER A SIGNATURE". A refusal and a
-- signature both leave the job at `review`; a refused job card is explicitly
-- still the office's to correct. So every guard below asks whether THIS job has
-- a signature, and says nothing about any job that does not.
--
-- Deletes and updates only. Nothing here blocks an INSERT, because the rows
-- that would be inserted against a signed job are refused by the same guard on
-- the way in — and because a table that cannot accept a row cannot be seeded.

CREATE OR REPLACE FUNCTION refuse_change_to_signed_job()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
BEGIN
  -- On DELETE the row is in OLD; on UPDATE either will do, and a row cannot
  -- change which job it belongs to (the foreign key sees to that).
  target := COALESCE(NEW.job_id, OLD.job_id);

  IF EXISTS (SELECT 1 FROM job_signatures WHERE job_id = target) THEN
    RAISE EXCEPTION
      'job % has been signed by the customer; % on % is not permitted. The signed job card is final.',
      target, TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER job_labour_frozen_once_signed
  BEFORE UPDATE OR DELETE ON job_labour
  FOR EACH ROW EXECUTE FUNCTION refuse_change_to_signed_job();
--> statement-breakpoint

CREATE TRIGGER job_travel_frozen_once_signed
  BEFORE UPDATE OR DELETE ON job_travel
  FOR EACH ROW EXECUTE FUNCTION refuse_change_to_signed_job();
--> statement-breakpoint

CREATE TRIGGER job_parts_frozen_once_signed
  BEFORE UPDATE OR DELETE ON job_parts
  FOR EACH ROW EXECUTE FUNCTION refuse_change_to_signed_job();
--> statement-breakpoint

CREATE TRIGGER job_media_frozen_once_signed
  BEFORE UPDATE OR DELETE ON job_media
  FOR EACH ROW EXECUTE FUNCTION refuse_change_to_signed_job();
--> statement-breakpoint

CREATE TRIGGER job_notes_frozen_once_signed
  BEFORE UPDATE OR DELETE ON job_notes
  FOR EACH ROW EXECUTE FUNCTION refuse_change_to_signed_job();
--> statement-breakpoint

-- The completion write-up and the captured commercial flags live on the job
-- row itself, so the guard is written against the columns rather than the
-- table: the job row legitimately keeps changing after signature — status
-- moves to awaiting_delivery, the final document is recorded, delivery is
-- confirmed — and freezing the whole row would stop the job being issued at
-- all. These are the fields the customer put their name to.
CREATE OR REPLACE FUNCTION refuse_signed_jobcard_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_signatures WHERE job_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  IF NEW.report_fault_findings IS DISTINCT FROM OLD.report_fault_findings
     OR NEW.report_diagnosis      IS DISTINCT FROM OLD.report_diagnosis
     OR NEW.report_work_performed IS DISTINCT FROM OLD.report_work_performed
     OR NEW.callout_applied       IS DISTINCT FROM OLD.callout_applied
     OR NEW.order_number          IS DISTINCT FROM OLD.order_number
     OR NEW.reference_number      IS DISTINCT FROM OLD.reference_number
     OR NEW.fault_description     IS DISTINCT FROM OLD.fault_description
  THEN
    RAISE EXCEPTION
      'job % has been signed by the customer; the job card text and charges are final.',
      OLD.job_number
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER jobs_signed_jobcard_frozen
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION refuse_signed_jobcard_rewrite();
