-- Who a piece of job media is FOR. MASTER SCOPE MEDIA-1.
--
-- `job_media` has never said whether a photograph belongs to the customer or to
-- EJE, and the customer's job card prints EVERY photograph's caption
-- (`lib/job-card/model.ts`). So a technician photographing a damaged part to
-- claim for it, or an unsafe installation to raise with the office, had its
-- caption printed on the document the customer signed. There was no way to say
-- otherwise, which is what MEDIA-2 was blocked on.
--
-- DEFAULT `customer_facing`, and the default is the whole migration strategy.
-- Every existing row already IS customer-facing in effect — its caption has been
-- on the document all along — so that is what it is recorded as. Marking existing
-- media internal would change what appears on documents for jobs nobody has
-- reviewed, including signed ones, which is not a migration's decision to make.
--
-- Additive, and the column carries a default, so old code inserting a row
-- without it still produces a valid record.

CREATE TYPE "public"."media_visibility" AS ENUM('customer_facing', 'internal');--> statement-breakpoint
ALTER TABLE "job_media" ADD COLUMN "visibility" "media_visibility" DEFAULT 'customer_facing' NOT NULL;
