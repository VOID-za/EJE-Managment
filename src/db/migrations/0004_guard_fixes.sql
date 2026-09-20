-- A corrected trigger function, and nothing else.
--
-- `checklist_version_in_use_guard` in 0002 declares a local variable named
-- `version_id` and then compares it against `checklist_instances.version_id`.
-- PL/pgSQL resolves the bare name to BOTH and refuses the statement with
-- "column reference version_id is ambiguous" — so the guard did not protect a
-- used checklist version, it simply made every write to `checklist_versions`
-- fail once any job had answered one. Archiving a version in order to publish
-- its successor is exactly that write, so the checklist admin path could not
-- work at all.
--
-- Found by the integration test that publishes v2.0 over v1.0 after a job has
-- answered v1.0, which is the sequence the business actually performs.
--
-- 0002 IS NOT TOUCHED. Migration history is append-only: a database that has
-- already run 0002 gets the fix from here, and one built from scratch gets the
-- original followed by the replacement. `CREATE OR REPLACE FUNCTION` leaves the
-- triggers themselves alone — they reference the function by name.

CREATE OR REPLACE FUNCTION checklist_version_in_use_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- Deliberately not `version_id`: that is also a column on the table this
  -- function queries, and an unqualified reference matches both.
  target_version uuid;
  used boolean;
BEGIN
  target_version := COALESCE(NEW.id, OLD.id);

  SELECT EXISTS (SELECT 1 FROM checklist_instances i WHERE i.version_id = target_version)
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
