-- 0049 — the Test & Repair delivery-note photo and the simpler Delivery Note,
-- 3 November 2026. ADDITIVE: no existing row is rewritten, no column dropped;
-- one NOT NULL is relaxed for a single job type and guarded by a check.
--
-- DN-SITE-OPT-1: a Delivery Note may be raised without a site. Every other job
-- type still must have one — the check says so, for every row old and new.
ALTER TABLE "jobs" ALTER COLUMN "site_id" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_site_required_unless_delivery_note"
    CHECK ("site_id" IS NOT NULL OR "job_type_code" = 'delivery_note');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- TR-REF-PHOTO-1: what an internal photograph is for. The office's photo of the
-- delivery note that came in with a Test & Repair job's parts is a
-- 'delivery_note_reference': always an INTERNAL PHOTO, so it can never reach
-- the job card or a customer document (which carry customer-facing photos only).
ALTER TABLE "job_media" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT '' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_media" ADD CONSTRAINT "job_media_purpose_known"
    CHECK ("purpose" IN ('', 'delivery_note_reference'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_media" ADD CONSTRAINT "job_media_reference_photo_internal"
    CHECK ("purpose" <> 'delivery_note_reference' OR ("kind" = 'photo' AND "visibility" = 'internal'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
