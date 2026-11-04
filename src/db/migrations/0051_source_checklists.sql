-- 0051 — the business's own checklists (CHK-SRC-1), 4 November 2026.
--
-- The Installation and Service checklists issued until now were demonstration
-- wording (version "1.0-DEMO", source "DEMO CONTENT — pending replacement").
-- This replaces them with the three source documents in docs/source-checklists/
-- — Installation, Service — Milling Machine, Service — Lathe — transcribed
-- exactly (docs/source-checklists/TRANSCRIPTION.md).
--
-- ADDITIVE AND HISTORY-PRESERVING. No row is deleted and no answer, instance,
-- signature or document is touched:
--   1. New columns, every one defaulted, so the release before this one runs
--      unchanged against it.
--   2. The immutability guards are extended to the new columns, and section
--      titles of a USED version are frozen too (they were not).
--   3. A started checklist records which checklist it is, and a trigger keeps
--      that equal to the checklist its version belongs to.
--   4. The three checklists are inserted as new families, version 1.0, current.
--   5. The demonstration versions still current for Installation and Service
--      are ARCHIVED — withdrawn from new jobs. They are not edited or deleted:
--      every job that answered them keeps rendering exactly what it answered.

-- 1. Columns.
ALTER TABLE "checklists" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
ALTER TABLE "checklists" ADD COLUMN IF NOT EXISTS "selection_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklists_kind_key" ON "checklists" ("kind") WHERE "kind" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_versions" ADD COLUMN IF NOT EXISTS "layout" jsonb;--> statement-breakpoint
ALTER TABLE "checklist_questions" ADD COLUMN IF NOT EXISTS "number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_questions" ADD COLUMN IF NOT EXISTS "group_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_questions" ADD COLUMN IF NOT EXISTS "fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_questions" ADD COLUMN IF NOT EXISTS "source_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_answers" ADD COLUMN IF NOT EXISTS "field_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD COLUMN IF NOT EXISTS "checklist_kind" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "checklist_questions" ADD CONSTRAINT "checklist_questions_fields_array"
    CHECK (jsonb_typeof("fields") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_field_values_object"
    CHECK (jsonb_typeof("field_values") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- 2. A used version's printed layout is part of its wording.
CREATE OR REPLACE FUNCTION checklist_version_in_use_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- Not `version_id`: that is also a column on the table queried (see 0004).
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
     OR NEW.source_document IS DISTINCT FROM OLD.source_document
     OR NEW.layout IS DISTINCT FROM OLD.layout THEN
    RAISE EXCEPTION
      'This checklist version has been used on a job. Start a new version instead of editing it.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- The section headings of a used version were editable; they are wording too.
CREATE OR REPLACE FUNCTION checklist_sections_in_use_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  used boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM checklist_instances i WHERE i.version_id = COALESCE(NEW.version_id, OLD.version_id)
  ) INTO used;

  IF used THEN
    RAISE EXCEPTION
      'This section belongs to a checklist version that has been used on a job. Start a new version instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS checklist_sections_in_use_guard ON checklist_sections;--> statement-breakpoint
CREATE TRIGGER checklist_sections_in_use_guard
  BEFORE UPDATE OR DELETE ON checklist_sections
  FOR EACH ROW EXECUTE FUNCTION checklist_sections_in_use_guard();--> statement-breakpoint

-- Which checklist a family IS may not change once a job has used it.
CREATE OR REPLACE FUNCTION checklists_kind_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (
    SELECT 1 FROM checklist_instances i
      JOIN checklist_versions v ON v.id = i.version_id
     WHERE v.checklist_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This checklist has been used on a job; which checklist it is cannot change.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS checklists_kind_guard ON checklists;--> statement-breakpoint
CREATE TRIGGER checklists_kind_guard
  BEFORE UPDATE ON checklists
  FOR EACH ROW EXECUTE FUNCTION checklists_kind_guard();--> statement-breakpoint

-- 3. The recorded choice is the checklist the version belongs to — never a
--    Lathe instance on Milling wording. Null only where the checklist has no
--    kind (the earlier wording). A writer that sends no kind — the release
--    before this one, after a rollback — has it filled in from the version
--    rather than refused, so a rollback cannot stop a technician starting a
--    checklist; a kind that CONTRADICTS the version is refused.
CREATE OR REPLACE FUNCTION checklist_instances_kind_matches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  family_kind text;
BEGIN
  SELECT c.kind INTO family_kind
    FROM checklist_versions v
    JOIN checklists c ON c.id = v.checklist_id
   WHERE v.id = NEW.version_id;

  IF NEW.checklist_kind IS NULL THEN
    NEW.checklist_kind := family_kind;
  END IF;

  IF NEW.checklist_kind IS DISTINCT FROM family_kind THEN
    RAISE EXCEPTION 'A checklist must record the checklist its wording belongs to (% is not %).',
      COALESCE(NEW.checklist_kind, 'none'), COALESCE(family_kind, 'none')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS checklist_instances_kind_matches ON checklist_instances;--> statement-breakpoint
CREATE TRIGGER checklist_instances_kind_matches
  BEFORE INSERT OR UPDATE OF version_id, checklist_kind ON checklist_instances
  FOR EACH ROW EXECUTE FUNCTION checklist_instances_kind_matches();--> statement-breakpoint

-- A FAIL STILL NEEDS A NOTE — WHEN THE CHECKLIST IS COMPLETED, not on the tap.
-- `checklist_answers_fail_needs_note` (0000) refused the answer row itself, but
-- the technician's screen saves each tap as it is made: tapping Fail is saved
-- before the note can be typed, and on PostgreSQL that tap was refused with a
-- server error (the demonstration store has no such constraint, so no browser
-- suite saw it). The rule moves to the moment it is about: the database
-- refuses to stamp a checklist complete while any Fail on it has no note —
-- exactly what `completeChecklist` already refuses in the application.
ALTER TABLE "checklist_answers" DROP CONSTRAINT IF EXISTS "checklist_answers_fail_needs_note";--> statement-breakpoint
CREATE OR REPLACE FUNCTION checklist_instances_fail_needs_note()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL AND EXISTS (
    SELECT 1 FROM checklist_answers a
     WHERE a.instance_id = NEW.id
       AND a.choice = 'fail'
       AND btrim(a.notes) = ''
  ) THEN
    RAISE EXCEPTION 'A checklist with a failed item and no note cannot be completed.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS checklist_instances_fail_needs_note ON checklist_instances;--> statement-breakpoint
CREATE TRIGGER checklist_instances_fail_needs_note
  BEFORE UPDATE OF completed_at ON checklist_instances
  FOR EACH ROW EXECUTE FUNCTION checklist_instances_fail_needs_note();--> statement-breakpoint
-- …and the other way in: an unexplained Fail written INTO a checklist already
-- completed (an instance inserted complete, then its answers). The answers
-- guard (0002) covers only UPDATE and DELETE; this covers the INSERT.
CREATE OR REPLACE FUNCTION checklist_answers_fail_needs_note()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.choice = 'fail' AND btrim(NEW.notes) = '' AND EXISTS (
    SELECT 1 FROM checklist_instances i WHERE i.id = NEW.instance_id AND i.completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A completed checklist cannot hold a failed item with no note.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS checklist_answers_fail_needs_note ON checklist_answers;--> statement-breakpoint
CREATE TRIGGER checklist_answers_fail_needs_note
  BEFORE INSERT ON checklist_answers
  FOR EACH ROW EXECUTE FUNCTION checklist_answers_fail_needs_note();--> statement-breakpoint

-- 5 (before 4, so nothing is ever briefly issued twice). Withdraw the
--    demonstration wording from NEW jobs. Status only — the guard permits
--    exactly this on a used version.
UPDATE "checklist_versions" v
   SET "status" = 'archived', "archived_at" = now(), "updated_at" = now()
  FROM "checklists" c
 WHERE c."id" = v."checklist_id"
   AND c."kind" IS NULL
   AND c."job_type_code" IN ('installation', 'service')
   AND v."status" = 'current';--> statement-breakpoint

-- The two job types these checklists belong to. Present on every database that
-- has run the application (the reference sync writes them); on an EMPTY one —
-- a fresh server being rebuilt, before the sync — they are not yet there, and
-- the checklists' foreign key would refuse this migration. As 0048 did for
-- Delivery Note: the application's own definition, and nothing if the row
-- exists (production's rows are untouched).
INSERT INTO "job_types" ("code", "label", "description", "checklist_required", "photos_required", "schedules_date_range",
  "captures_labour_and_travel", "visits_site", "order_number_expectation", "captures_delivery_note", "collected_on_completion",
  "default_priority", "accent", "position")
VALUES
  ('installation', 'Installation', 'Commissioning and hand-over of a machine at a customer site.',
    true, true, false, true, true, 'expected', false, false, 'normal', 'blue', 1),
  ('service', 'Service', 'Planned preventative maintenance against the service schedule.',
    true, false, true, true, true, 'expected', false, false, 'normal', 'green', 2)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- 4. The three source checklists. Generated from
--    src/data/checklists/source-checklists.ts; source-checklists.db.test.ts
--    proves the rows equal it.
-- Installation: 36 rows.
INSERT INTO "checklists" ("id", "name", "description", "job_type_code", "kind", "selection_label") VALUES ('69479130-a5bf-5041-a6ef-eb91dddab44b', 'Installation', 'The WD Hearn Installation Procedure, transcribed exactly from docs/source-checklists/installation.pdf (2 pages).', 'installation', 'installation', '');--> statement-breakpoint
INSERT INTO "checklist_versions" ("id", "checklist_id", "version", "status", "source_document", "layout", "published_at", "updated_at") VALUES ('49a75e9e-5932-54e7-b642-2f88bb1839e4', '69479130-a5bf-5041-a6ef-eb91dddab44b', '1.0', 'current', 'docs/source-checklists/installation.pdf — WD Hearn Machine Tools "Installation Procedure", 2 pages', '{"title":"Installation Procedure","letterhead":"WD Hearn Machine Tools — Established 1937","headerFields":[{"label":"QT #","source":"quote_number"},{"label":"INV #","source":"invoice_number"},{"label":"Company name:","source":"customer"},{"label":"Company address:","source":"site_address"},{"label":"Customer name:","source":"contact"},{"label":"Machine make:","source":"machine_make"},{"label":"Machine model:","source":"machine_model"},{"label":"Machine control:","source":"machine_control"},{"label":"Serial no:","source":"serial_number"},{"label":"Installation date:","source":"date"}],"columns":{"number":"","description":"Procedure","tick":"✓","comments":"Comments"},"notes":["Please hand in all documents to Juanita & e-mail XML/backup/maintenance file to jhb@wdhearn.co.za","If procedure is not filled in and correctly filled in, no training will be scheduled."],"closing":"","signatures":[{"label":"Engineer (print name)","role":"engineer_name"},{"label":"Engineer Signature","role":"engineer_signature"},{"label":"Customer (print name)","role":"customer_name"},{"label":"Customer Signature","role":"customer_signature"}]}'::jsonb, '2026-11-04T12:00:00.000Z', '2026-11-04T12:00:00.000Z');--> statement-breakpoint
INSERT INTO "checklist_sections" ("id", "version_id", "title", "description", "position") VALUES
  ('750e8c83-1c5f-5162-a21c-d8035db5423d', '49a75e9e-5932-54e7-b642-2f88bb1839e4', '', '', 0);--> statement-breakpoint
INSERT INTO "checklist_questions" ("id", "section_id", "text", "help_text", "response_type", "required", "photo_required", "position", "number", "group_label", "fields", "source_note") VALUES
  ('231fd438-4b20-5a13-b1be-36a221cafc46', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Tightness check on all electrical connections', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('f59a9e7a-1331-51c0-81b1-07019a1a8dc4', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check electrical voltage', '', 'pass_fail_na', true, false, 1, '2', '', '[{"id":"r","label":"R","unit":""},{"id":"s","label":"S","unit":""},{"id":"t","label":"T","unit":""}]'::jsonb, ''),
  ('34d5e414-5c5d-5655-90c0-bd487442fc8d', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check electrical voltage - Transformer', '', 'pass_fail_na', true, false, 2, '3', '', '[{"id":"r","label":"R","unit":""},{"id":"s","label":"S","unit":""},{"id":"t","label":"T","unit":""}]'::jsonb, ''),
  ('91800a4f-cce1-5df5-8118-32ef432b8fcd', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check 24V', '', 'pass_fail_na', true, false, 3, '4', '', '[]'::jsonb, ''),
  ('1e8e223e-db28-57d7-bb28-330a51cb9599', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Lubrication pressure', '', 'pass_fail_na', true, false, 4, '5', '', '[{"id":"value","label":"","unit":"Bar/PSI"}]'::jsonb, ''),
  ('be92b494-e041-5b5a-99cb-05031dc281b3', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Lubrication cycle', '', 'pass_fail_na', true, false, 5, '6', '', '[{"id":"on_time","label":"On time:","unit":""},{"id":"off_time","label":"Off time:","unit":""}]'::jsonb, ''),
  ('ea146031-4be1-5194-babd-ad6fbfb240df', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Hydraulic Oil', '', 'pass_fail_na', true, false, 6, '7', 'Check all oil levels:', '[]'::jsonb, ''),
  ('b34f33fa-9ffd-57fd-9b87-b73de0a53703', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Chiller Unit Oil', '', 'pass_fail_na', true, false, 7, '7', 'Check all oil levels:', '[]'::jsonb, ''),
  ('f07aadea-e802-5150-ab2d-3b888ac45a94', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Turret Oil', '', 'pass_fail_na', true, false, 8, '7', 'Check all oil levels:', '[]'::jsonb, ''),
  ('d6122b64-0f07-5ea8-ad23-cfadb4347c76', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Tool Arm gearbox Oil', '', 'pass_fail_na', true, false, 9, '7', 'Check all oil levels:', '[]'::jsonb, ''),
  ('6207d959-c288-52da-be55-bc9f578ad40e', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Air Lube Oil', '', 'pass_fail_na', true, false, 10, '7', 'Check all oil levels:', '[]'::jsonb, ''),
  ('029ccc84-77eb-54a3-a06b-b3111f7352eb', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Lubrication Oil', '', 'pass_fail_na', true, false, 11, '7', 'Check all oil levels:', '[]'::jsonb, ''),
  ('cd059077-f66b-5ebd-9448-76b852ee0eb8', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Phase rotation (rotation of all motors)', '', 'pass_fail_na', true, false, 12, '8', '', '[]'::jsonb, ''),
  ('bbf5a058-6dd7-5b3a-9e51-1a2f7a6ee801', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check general condition of the machine', '', 'pass_fail_na', true, false, 13, '9', '', '[]'::jsonb, ''),
  ('c9760f82-9585-51fe-aa41-2068cf4b2be3', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Level the machine', '', 'pass_fail_na', true, false, 14, '10', '', '[]'::jsonb, ''),
  ('eccfcfe7-4c2d-529c-bef7-1b383c082a4a', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Trepan the table from the spindle and adjust the leveling bolts', '', 'pass_fail_na', true, false, 15, '11', '', '[]'::jsonb, ''),
  ('d00094c8-1431-578c-944a-5b1fb71b3856', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check hydraulic pump pressure', '', 'pass_fail_na', true, false, 16, '12', '', '[{"id":"value","label":"","unit":"KPA/PSI"}]'::jsonb, ''),
  ('7fce09d8-ea8e-5d12-a896-71ebfcb41c96', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check lubrication pressure', '', 'pass_fail_na', true, false, 17, '13', '', '[{"id":"value","label":"","unit":"KPA/PSI"}]'::jsonb, ''),
  ('5d8d1ba7-53ac-5a42-a790-1acfc3f48554', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check air pressure', '', 'pass_fail_na', true, false, 18, '14', '', '[{"id":"value","label":"","unit":"KPA"}]'::jsonb, ''),
  ('e481802b-f500-5d95-a5cb-22f48f4c02e4', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check and adjust the positive air pressure from the spindle nose', '', 'pass_fail_na', true, false, 19, '15', '', '[{"id":"value","label":"","unit":"KPA (0.2)"}]'::jsonb, ''),
  ('7ff105f4-e45c-51bd-bb9a-544597953f0d', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check all axis reference position', '', 'pass_fail_na', true, false, 20, '16', '', '[]'::jsonb, ''),
  ('35caf0b7-797b-59dd-bd67-10feb00b22e7', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check the Z axis tool change position', '', 'pass_fail_na', true, false, 21, '17', '', '[]'::jsonb, ''),
  ('34984a9f-7464-5b6b-9c5b-26dccb3befe0', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check spindle orientation', '', 'pass_fail_na', true, false, 22, '18', '', '[]'::jsonb, ''),
  ('26f2b1f0-ead3-5338-b800-82ae1df2680f', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Do a actual tool change with 2 tool holders', '', 'pass_fail_na', true, false, 23, '19', '', '[]'::jsonb, ''),
  ('b1987646-53ac-5eec-9850-82ca790b914e', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Make sure all the covers are fitted correctly with all the screws', '', 'pass_fail_na', true, false, 24, '20', '', '[]'::jsonb, ''),
  ('6bf4f1e8-b7ee-5556-b540-0f6947ad08aa', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Test that the lubrication pump works in auto mode (move any axis)', '', 'pass_fail_na', true, false, 25, '21', '', '[]'::jsonb, ''),
  ('cb6408cb-2f73-5ee9-9288-ffd3ba201652', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Test the coolant system and check for leaks', '', 'pass_fail_na', true, false, 26, '22', '', '[]'::jsonb, ''),
  ('8843894a-2cef-52c8-9c6a-22be543b9e29', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Run the spindle in (start at 500rpm and increase 500 rpm every 30 minutes)', '', 'pass_fail_na', true, false, 27, '23', '', '[]'::jsonb, ''),
  ('e4c924bd-a223-5bac-96ee-80dcc91d3501', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Spindle Bearing Test', '', 'pass_fail_na', true, false, 28, '24', '', '[]'::jsonb, ''),
  ('e546637e-2f0e-5d96-b593-f479befa69ff', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Belt Tension Test', '', 'pass_fail_na', true, false, 29, '25', '', '[]'::jsonb, ''),
  ('be1347ff-a987-5228-a0e7-6bd9f24714db', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Make copies of the CD disks', '', 'pass_fail_na', true, false, 30, '26', '', '[]'::jsonb, ''),
  ('51bd04b3-22fa-5f54-88c7-a0b9fd8fa1b4', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check the manuals and data sheet with the customer and ask for a signature', '', 'pass_fail_na', true, false, 31, '27', '', '[]'::jsonb, ''),
  ('55385383-3546-5e0f-b4c9-e5c147248697', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Check the parts and tool list with the customer and ask for a signature', '', 'pass_fail_na', true, false, 32, '28', '', '[]'::jsonb, ''),
  ('a06e5077-b4bb-5b9c-a73b-ac46d02fe517', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Fill in the warranty service note', '', 'pass_fail_na', true, false, 33, '29', '', '[]'::jsonb, ''),
  ('a679adc5-98e8-57d4-9a12-bbc6f37fffad', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Fanuc Warranty Screenshot', '', 'pass_fail_na', true, false, 34, '30', '', '[]'::jsonb, ''),
  ('d23b733b-29a7-5558-89fa-3cb64a647062', '750e8c83-1c5f-5162-a21c-d8035db5423d', 'Download a maintenance file/back up
If Siemens: Extract XML File', '', 'pass_fail_na', true, false, 35, '31', '', '[]'::jsonb, '');--> statement-breakpoint
-- Service — Milling Machine: 39 rows.
INSERT INTO "checklists" ("id", "name", "description", "job_type_code", "kind", "selection_label") VALUES ('fc0f1a1f-c0f3-5a40-89b6-adc18e8ac24f', 'Service — Milling Machine', 'The Preventative Maintenance Checklist - Machining Centre, transcribed exactly from docs/source-checklists/service-milling.pdf (2 pages).', 'service', 'service_milling', 'Milling Machine / Machining Centre');--> statement-breakpoint
INSERT INTO "checklist_versions" ("id", "checklist_id", "version", "status", "source_document", "layout", "published_at", "updated_at") VALUES ('9a603e30-011a-55da-9c1a-d9a29389cee5', 'fc0f1a1f-c0f3-5a40-89b6-adc18e8ac24f', '1.0', 'current', 'docs/source-checklists/service-milling.pdf — "Preventative Maintenance Checklist - Machining Centre", 2 pages', '{"title":"PREVENTATIVE MAINTENANCE CHECKLIST - MACHINING CENTRE","letterhead":"","headerFields":[{"label":"CUSTOMER:","source":"customer"},{"label":"MACHINE MAKE:","source":"machine_make"},{"label":"MACHINE MODEL:","source":"machine_model"},{"label":"SERIAL NUMBER:","source":"serial_number"},{"label":"DATE:","source":"date"}],"columns":{"number":"OP","description":"DESCRIPTION","tick":"","comments":"COMMENTS / NOTES"},"notes":[],"closing":"ALL CHECKS COMPLETE","signatures":[{"label":"ENGINEER (PRINT NAME)","role":"engineer_name"},{"label":"CUSTOMER (PRINT NAME)","role":"customer_name"},{"label":"ENGINEER (SIGNATURE)","role":"engineer_signature"},{"label":"CUSTOMER (SIGNATURE)","role":"customer_signature"}]}'::jsonb, '2026-11-04T12:00:00.000Z', '2026-11-04T12:00:00.000Z');--> statement-breakpoint
INSERT INTO "checklist_sections" ("id", "version_id", "title", "description", "position") VALUES
  ('15b7ee30-18c8-570e-9dbc-c0ac4e028b35', '9a603e30-011a-55da-9c1a-d9a29389cee5', 'GENERAL', '', 0),
  ('45ff9f87-9ce9-5217-ab50-f6cf56be800e', '9a603e30-011a-55da-9c1a-d9a29389cee5', 'ELECTRICAL', '', 1),
  ('9bb88447-f159-56e4-9da0-12cb98b8ebb5', '9a603e30-011a-55da-9c1a-d9a29389cee5', 'LUBRICATION', '', 2),
  ('49e134a6-f401-53a3-b7a4-a0cea6438b17', '9a603e30-011a-55da-9c1a-d9a29389cee5', 'HYDRAULICS', '', 3),
  ('deb57fa5-b93e-5ea9-92ea-6fbabcefc2d7', '9a603e30-011a-55da-9c1a-d9a29389cee5', 'PNEUMATICS', '', 4),
  ('da86a7a1-22df-5f03-8ae2-55a41a5d364c', '9a603e30-011a-55da-9c1a-d9a29389cee5', 'COOLANT', '', 5),
  ('32f4c4e8-8f74-5697-8143-a7f840fe905a', '9a603e30-011a-55da-9c1a-d9a29389cee5', 'BACK UP', '', 6),
  ('a6436f4f-3e70-5c6c-9d3a-6175708c05b9', '9a603e30-011a-55da-9c1a-d9a29389cee5', 'THERMAL CHECK', '', 7);--> statement-breakpoint
INSERT INTO "checklist_questions" ("id", "section_id", "text", "help_text", "response_type", "required", "photo_required", "position", "number", "group_label", "fields", "source_note") VALUES
  ('5cc36982-6647-54a2-8fad-dcd07ecfb53d', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check machine level, squareness of slideways, spindle alignment and runout.
(By request only prior to visit)', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('fd31b80b-95b3-5962-907e-36d4b9c36d65', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check and adjust X,Y,Z-Axis Backlash compensation', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('b2aa7d72-789f-54d9-8015-4c9031e635fb', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check X,Y, Z Axis zero return.
(adjust if required by customer)', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('cd91bb91-9b58-56de-b683-aa2827211ea8', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check telescopic slide way guards and wipers', '', 'pass_fail_na', true, false, 3, '4', '', '[]'::jsonb, ''),
  ('80f096d7-71ca-5891-8206-0df4a71cf106', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check tool unclamp stroke', '', 'pass_fail_na', true, false, 4, '5', '', '[]'::jsonb, ''),
  ('106f6f67-ca08-5513-8ae2-4aa3722969e8', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check collet on end of draw bar', '', 'pass_fail_na', true, false, 5, '6', '', '[]'::jsonb, ''),
  ('abe67997-3468-55e1-be38-99c79192e0f8', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check ATC function, check fingers and pockets for wear. Check for play in tool lock release mechanism', '', 'pass_fail_na', true, false, 6, '7', '', '[]'::jsonb, ''),
  ('c1cf107f-e915-58b9-ae0c-ce13c9cbc2d0', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check for bearing noise X, Y, Z Axis', '', 'pass_fail_na', true, false, 7, '8', '', '[]'::jsonb, ''),
  ('f7b654c6-c3cb-5615-8cdb-1035308e6484', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check for bearing noise spindle', '', 'pass_fail_na', true, false, 8, '9', '', '[]'::jsonb, ''),
  ('2f8136f2-daaa-5300-9333-f57c2f8f5f47', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check for oil and air leaks', '', 'pass_fail_na', true, false, 9, '10', '', '[]'::jsonb, ''),
  ('d0c05ef9-7260-53b0-a54f-82c670270f12', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check linear rail wipers for wear', '', 'pass_fail_na', true, false, 10, '11', '', '[]'::jsonb, ''),
  ('13f749c3-be2e-5360-b544-cd628bb4ae90', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check Spindle Orientation', '', 'pass_fail_na', true, false, 11, '12', '', '[]'::jsonb, ''),
  ('ce5386a7-5f87-5eb1-886e-5e4a7ee65927', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'Check Spindle Drive belt for wear and tention', '', 'pass_fail_na', true, false, 12, '13', '', '[]'::jsonb, ''),
  ('69bd74ba-38a2-56e3-bb40-7025ea5f2a1b', '15b7ee30-18c8-570e-9dbc-c0ac4e028b35', 'APC (if fitted)
Check accuracy of APC and check clamping faces for wear', '', 'pass_fail_na', true, false, 13, '14', '', '[]'::jsonb, ''),
  ('a68346e1-bfce-5246-a782-9d43a9bc8b2b', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check main supply voltage', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('9922623d-5936-5d2f-9eeb-015fc26f3417', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check for tightness of magnetic switches, relays, thermal relays, fuses, circuit breakers, servo connectors, terminal, etc.', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('c6f0e42c-e721-570e-933e-3d7b36e359a6', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check work lamp and indicator lamps', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('b760cadd-b992-53e4-b897-c91e1d3654ee', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check push button and switches', '', 'pass_fail_na', true, false, 3, '4', '', '[]'::jsonb, ''),
  ('f45f5ee7-fe78-5792-8472-96247dbbd898', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check function of each emergency stop', '', 'pass_fail_na', true, false, 4, '5', '', '[]'::jsonb, ''),
  ('94b178c0-1be4-5060-9f8b-c97179688699', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check function of door locks and interlocks', '', 'pass_fail_na', true, false, 5, '6', '', '[]'::jsonb, ''),
  ('88958581-57ac-5a27-99cc-59c6ec74594d', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check for dirt, oil in electrical control cabinets and advise how to clean if required', '', 'pass_fail_na', true, false, 6, '7', '', '[]'::jsonb, ''),
  ('949f8d86-f6c3-5e10-b358-6bd50e03c63c', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Clean electrical cabinet filters and fans', '', 'pass_fail_na', true, false, 7, '8', '', '[]'::jsonb, ''),
  ('077ad951-1ae3-5daf-946c-3ec3dcd7046b', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check & clean electrical motor fans', '', 'pass_fail_na', true, false, 8, '9', '', '[]'::jsonb, ''),
  ('99bce411-d10a-53e6-a2a4-28612ecaa768', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Check external cables for damage', '', 'pass_fail_na', true, false, 9, '10', '', '[]'::jsonb, ''),
  ('972af260-3e3e-5825-ab3d-9cb1dc7b8c46', '45ff9f87-9ce9-5217-ab50-f6cf56be800e', 'Replaced FANUC control battery', '', 'pass_fail_na', true, false, 10, '11', '', '[]'::jsonb, ''),
  ('fc849abe-a705-50ce-a01f-0cb848e6d290', '9bb88447-f159-56e4-9da0-12cb98b8ebb5', 'Clean spindle lube tank, Change oil, clean/replace filters.', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('dc21582d-4e9a-5749-99b6-d459866f4537', '9bb88447-f159-56e4-9da0-12cb98b8ebb5', 'Check Lubrication pump pressure', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('b2842d8a-5f57-53e4-9283-11f46ed97bc4', '9bb88447-f159-56e4-9da0-12cb98b8ebb5', 'Check that there is oil on the ballscrews and linear ways', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('75660b63-17d1-5126-9a69-48ea0b48c79f', '9bb88447-f159-56e4-9da0-12cb98b8ebb5', 'Check ATC box oil', '', 'pass_fail_na', true, false, 3, '4', '', '[]'::jsonb, ''),
  ('a4113b22-5482-50ce-ac68-8f9305c4ed23', '49e134a6-f401-53a3-b7a4-a0cea6438b17', '(if Fitted APC)
a. Clean hydraulic tank and filter, change oil b. Check hydraulic pressure settings', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('751278eb-d8e7-5ceb-b099-3d8a027a49d2', '49e134a6-f401-53a3-b7a4-a0cea6438b17', 'SPINDLE OIL COOLER Checkoil and check air filters. Airblast clean the condenser cooling fans', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('7addb236-3f09-5acf-a85a-cf037cbe8321', 'deb57fa5-b93e-5ea9-92ea-6fbabcefc2d7', 'Clean air/oil units and clean/replace filters', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('be25e5ed-8c03-58c1-9985-2ea909b3c26d', 'deb57fa5-b93e-5ea9-92ea-6fbabcefc2d7', 'Check and Adjust air/oil pressures if necessary', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('5a17af54-50ea-5304-8f36-71dd53573e45', 'deb57fa5-b93e-5ea9-92ea-6fbabcefc2d7', 'Check for air blast at ATC', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('91c359ae-52ba-58a9-8920-f043ad624334', 'da86a7a1-22df-5f03-8ae2-55a41a5d364c', 'Check filters', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('121e32f7-79d4-5666-9203-f08c8a246817', 'da86a7a1-22df-5f03-8ae2-55a41a5d364c', 'Clean Grids', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('dbc9fc3c-f40a-5b28-a1db-300d34f0e8d3', 'da86a7a1-22df-5f03-8ae2-55a41a5d364c', 'Clean Tank', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('66b788a4-5c77-53dd-ab3f-e9e4a52304fb', '32f4c4e8-8f74-5697-8143-a7f840fe905a', 'Make Machine Back up', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('70a16417-643b-5e9f-bb02-a0313d756131', 'a6436f4f-3e70-5c6c-9d3a-6175708c05b9', 'Picture Machine when running Electrical Panel and Motors', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, '');--> statement-breakpoint
-- Service — Lathe: 41 rows.
INSERT INTO "checklists" ("id", "name", "description", "job_type_code", "kind", "selection_label") VALUES ('a664c9a7-e7c9-527b-b920-d02c6bd7313f', 'Service — Lathe', 'The Preventative Maintenace Checklist - Lathe, transcribed exactly from docs/source-checklists/service-lathe.pdf (2 pages), including its handwritten addition.', 'service', 'service_lathe', 'Lathe');--> statement-breakpoint
INSERT INTO "checklist_versions" ("id", "checklist_id", "version", "status", "source_document", "layout", "published_at", "updated_at") VALUES ('05a25ef4-00d2-5585-8218-1056546520a4', 'a664c9a7-e7c9-527b-b920-d02c6bd7313f', '1.0', 'current', 'docs/source-checklists/service-lathe.pdf — "Preventative Maintenace Checklist - Lathe", 2 pages, one handwritten addition', '{"title":"PREVENTATIVE MAINTENACE CHECKLIST - LATHE","letterhead":"","headerFields":[{"label":"CUSTOMER:","source":"customer"},{"label":"MACHINE MAKE:","source":"machine_make"},{"label":"MACHINE MODEL:","source":"machine_model"},{"label":"SERIAL NUMBER:","source":"serial_number"},{"label":"DATE:","source":"date"}],"columns":{"number":"OP","description":"DESCRIPTION","tick":"","comments":"COMMENTS / NOTES"},"notes":[],"closing":"","signatures":[{"label":"ENGINEER (SIGNATURE)","role":"engineer_signature"},{"label":"CUSTOMER (SIGNATURE)","role":"customer_signature"}]}'::jsonb, '2026-11-04T12:00:00.000Z', '2026-11-04T12:00:00.000Z');--> statement-breakpoint
INSERT INTO "checklist_sections" ("id", "version_id", "title", "description", "position") VALUES
  ('82300267-67a6-5f4b-9ee3-6cc472e7b6d6', '05a25ef4-00d2-5585-8218-1056546520a4', 'GENERAL', '', 0),
  ('ac30746d-ad29-56bf-936c-348ec3ba4b53', '05a25ef4-00d2-5585-8218-1056546520a4', 'ELECTRICAL', '', 1),
  ('658b4de6-4d47-59c4-9cbc-9928948e7ec1', '05a25ef4-00d2-5585-8218-1056546520a4', 'LUBRICATION', '', 2),
  ('4a99f739-7b1b-58fd-8d0c-2ab0b12c0abf', '05a25ef4-00d2-5585-8218-1056546520a4', 'HYDRAULICS', '', 3),
  ('b4372cc6-ffb6-5e23-bc74-8589555b91ea', '05a25ef4-00d2-5585-8218-1056546520a4', 'PNEUMATICS', '', 4),
  ('35fbc773-0360-5805-828b-c881376f3a09', '05a25ef4-00d2-5585-8218-1056546520a4', 'BACK UP', '', 5),
  ('0bca6ac4-93c8-56e7-8546-be9d316a0263', '05a25ef4-00d2-5585-8218-1056546520a4', 'THERMAL CHECK', '', 6);--> statement-breakpoint
INSERT INTO "checklist_questions" ("id", "section_id", "text", "help_text", "response_type", "required", "photo_required", "position", "number", "group_label", "fields", "source_note") VALUES
  ('9babe6bd-d5fa-5ac8-93e2-3f7727d35f2a', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check machine level, Requires levelling plate
(By request only prior to visit)', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('3374966c-6e7e-5035-a9e8-977fae1ff5c1', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check and adjust X,Z-Axis Backlash', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('1111d930-38ca-5b8c-821e-ed87a5a4d7f8', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check Spindle Drive belt for wear and deterioration & Tension', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('82ce5d3f-5043-5f08-b8c2-42ec7ba28fee', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check X Axis Brake for operation', '', 'pass_fail_na', true, false, 3, '4', '', '[]'::jsonb, ''),
  ('bb2c6e16-7fce-523c-98ac-cae3c187ecdf', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check Z Axis drive belts for tention and deterioration', '', 'pass_fail_na', true, false, 4, '5', '', '[]'::jsonb, ''),
  ('69bde05a-403a-5013-a568-969af79809b9', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check gear exchange operation', '', 'pass_fail_na', true, false, 5, '6', '', '[]'::jsonb, ''),
  ('20862037-3f4b-54ec-982f-dd7365e8a8cf', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check for any oil, air coolant leaks', '', 'pass_fail_na', true, false, 6, '7', '', '[]'::jsonb, ''),
  ('ab6901c2-e0cd-565d-a6b6-4a4a7fa8fb4e', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check for bearing noise X, Z Axis
Check for bearing noise spindle
Check for bearing noise gearbox', '', 'pass_fail_na', true, false, 7, '8', '', '[]'::jsonb, ''),
  ('572a2492-660b-5c74-96f0-a07b62bf94a4', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check Z Axis slideway guards and wipers', '', 'pass_fail_na', true, false, 8, '9', '', '[]'::jsonb, ''),
  ('421c2aa1-6bb2-5e26-89a1-7d039499ae58', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check X and Z slideway wipers for wear', '', 'pass_fail_na', true, false, 9, '10', '', '[]'::jsonb, ''),
  ('9c9d3b23-69e2-5b66-8c43-a0529c6c68ad', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check Turret alignment X and Z Axis', '', 'pass_fail_na', true, false, 10, '11', '', '[]'::jsonb, ''),
  ('107d58ae-9ae1-57c8-805a-65d775427a78', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check Turret centerline, adjust if necessary
(X Axis stroke)', '', 'pass_fail_na', true, false, 11, '12', '', '[]'::jsonb, ''),
  ('43dd1929-e091-55c3-8ee8-7d9cdf00c656', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'Check flexible tracking for wear and deterioration', '', 'pass_fail_na', true, false, 12, '13', '', '[]'::jsonb, ''),
  ('9a07cbde-b801-5f4e-b034-d7ae224e0eb8', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'TAILSTOCK (if fitted)
Check condition of revolving centre', '', 'pass_fail_na', true, false, 13, '14', '', '[]'::jsonb, ''),
  ('614f6cd9-6db3-5913-b532-e387e73e7dc1', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'PARTS CATCHER (if fitted)
Check for correct operation and damage', '', 'pass_fail_na', true, false, 14, '15', '', '[]'::jsonb, ''),
  ('6b5b8193-1236-542b-b9a0-185a7a1a22e2', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'MANUAL TOOLSETTER (if fitted)
Check for damage and recalibrate (customer to supply soft metal billet for recalibration.)', '', 'pass_fail_na', true, false, 15, '16', '', '[]'::jsonb, ''),
  ('a05edd75-e25c-5304-b771-e97f3c626d6f', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'ROTARY TOOL (if fitted)
Check Rotary Tool drive on turret', '', 'pass_fail_na', true, false, 16, '17', '', '[]'::jsonb, ''),
  ('fa1c7097-41be-5e1f-9a75-ac2e2462d305', '82300267-67a6-5f4b-9ee3-6cc472e7b6d6', 'ROTARY TOOL (if fitted)
Check drive belts for tension and deterioration', '', 'pass_fail_na', true, false, 17, '18', '', '[]'::jsonb, ''),
  ('e2064a77-ce0c-57c3-b1f7-2a0001dd5c91', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check main supply voltage', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('ddf715fe-0025-5db7-95e9-68564a3f54c0', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check for tightness of magnetic switches, relays, thermal relays, fuses, circuit breakers, servo connectors, terminal, etc.', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('12345053-c904-563f-8710-fc0be2b66b16', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check work lamp and indicator lamps', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('e6763fc3-5cba-5318-9d72-8ea6ff389983', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check push button and switches', '', 'pass_fail_na', true, false, 3, '4', '', '[]'::jsonb, ''),
  ('6df9f58a-d312-5087-aaca-c377e39492b7', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check function of each emergency stop', '', 'pass_fail_na', true, false, 4, '5', '', '[]'::jsonb, ''),
  ('49ce73ee-0a1f-5e6f-b583-b8caccd634f3', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Changed Fanuc control battery', '', 'pass_fail_na', true, false, 5, '', '', '[]'::jsonb, 'Handwritten on the supplied source.'),
  ('ee376a9a-6336-59ee-9415-e69345be464c', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check & clean electrical motor fans', '', 'pass_fail_na', true, false, 6, '', '', '[]'::jsonb, 'Printed in a separate, unnumbered box on the supplied source.'),
  ('942dd102-1c2b-5db7-8fbf-812b9e61748b', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check function of door locks and interlocks', '', 'pass_fail_na', true, false, 7, '6', '', '[]'::jsonb, ''),
  ('cf6b0dc0-1161-5b77-8868-60c3aedefc0c', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check and adjust spindle load monitor', '', 'pass_fail_na', true, false, 8, '7', '', '[]'::jsonb, ''),
  ('a70109e9-6022-553c-a88a-340f990268b6', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check for dirt, oil in electrical control cabinets and advise how to clean if required', '', 'pass_fail_na', true, false, 9, '8', '', '[]'::jsonb, ''),
  ('aef05be5-b560-5368-a12c-e78aa5e5b9d5', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Clean electrical cabinet filters and fans', '', 'pass_fail_na', true, false, 10, '9', '', '[]'::jsonb, ''),
  ('913edb74-5f49-5f36-8cb3-611fcb6bae6a', 'ac30746d-ad29-56bf-936c-348ec3ba4b53', 'Check external cables for damage', '', 'pass_fail_na', true, false, 11, '10', '', '[]'::jsonb, ''),
  ('0bc75f56-8cfa-5ca3-a317-813cd3871cd8', '658b4de6-4d47-59c4-9cbc-9928948e7ec1', 'Clean auto lube tank and port filter, Change oil, clean/replace suction filter.', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('d719761d-d7be-5e1b-90d6-b6c1722db7a6', '658b4de6-4d47-59c4-9cbc-9928948e7ec1', 'Check Lubrication pump pressure', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('7655a07c-ebf8-5432-88ca-c3565f227e4c', '658b4de6-4d47-59c4-9cbc-9928948e7ec1', 'Check for oil appearing on slideways and ballscrews', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('361a890e-9aca-5a19-bc41-24b5fc7643d8', '4a99f739-7b1b-58fd-8d0c-2ab0b12c0abf', 'Clean Hydraulic tank and filter. Change oil', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('5ec2fa86-c43d-5f16-9bea-26c7716317bf', '4a99f739-7b1b-58fd-8d0c-2ab0b12c0abf', 'Check Tailstock pressure, chucking pressure and main pressure gauges for correct operation and damage', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('f25383e2-3ff5-5704-b1e0-71c2c7d05ea1', '4a99f739-7b1b-58fd-8d0c-2ab0b12c0abf', 'Check Chuck clamp/unclamp working correctly', '', 'pass_fail_na', true, false, 2, '3', '', '[]'::jsonb, ''),
  ('4216dfd4-11c8-5659-8023-1f618ffc4fa9', '4a99f739-7b1b-58fd-8d0c-2ab0b12c0abf', 'SPINDLE OIL COOLER Clean tank and filter, change oil and check air filters', '', 'pass_fail_na', true, false, 3, '4', '', '[]'::jsonb, ''),
  ('75198204-37b3-5c27-a0c9-a3e4e4eb8dd8', 'b4372cc6-ffb6-5e23-bc74-8589555b91ea', 'Clean air/oil units and clean/replace filters', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('f7dfce06-3e5c-59c3-9f11-c5291624c4b7', 'b4372cc6-ffb6-5e23-bc74-8589555b91ea', 'Check air gauges and pressure adjust if necessary', '', 'pass_fail_na', true, false, 1, '2', '', '[]'::jsonb, ''),
  ('170d53a9-6523-59a7-87f0-48676d30e39c', '35fbc773-0360-5805-828b-c881376f3a09', 'Make Machine Back up', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, ''),
  ('4bdbbd96-54aa-5dda-86e4-ef86912d1f4f', '0bca6ac4-93c8-56e7-8546-be9d316a0263', 'Picture Machine when running Electrical Panel and Motors', '', 'pass_fail_na', true, false, 0, '1', '', '[]'::jsonb, '');
