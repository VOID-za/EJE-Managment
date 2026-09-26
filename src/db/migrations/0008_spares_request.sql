-- A spares request, not a sentence. MASTER SCOPE SPARE-2.
--
-- `awaiting_spares_reason` has carried the whole of it since 0000: one free-text
-- line holding what was needed, with no record of WHEN it was asked for, no room
-- for anything the office added afterwards, and no way to point at the
-- photograph the technician took of the part.
--
-- Nothing is renamed and nothing is dropped. The existing column already holds
-- the DESCRIPTION and keeps its data; these three are what it never had.
--
--  * `awaiting_spares_notes` — what the office or the technician added after the
--    request was raised. Separate from the description because the description
--    is what was asked for and must not be edited into something else.
--  * `awaiting_spares_photo_id` — one of the job's OWN photographs. Nullable and
--    `ON DELETE SET NULL`: removing the photograph must not take the spares
--    request with it.
--  * `awaiting_spares_requested_at` — the moment the request was made. Null on
--    every job that has never waited for spares, which is what distinguishes
--    "no request" from "a request with nothing in it".
--
-- Additive, like every migration here: old code runs against this schema
-- unchanged, which is what makes a rollback by checking out old code safe.

ALTER TABLE "jobs" ADD COLUMN "awaiting_spares_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "awaiting_spares_photo_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "awaiting_spares_requested_at" timestamp with time zone;