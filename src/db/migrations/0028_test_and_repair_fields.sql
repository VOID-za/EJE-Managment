-- THE UNIT BOOKED IN FOR TEST AND REPAIR, AND THE CUSTOMER'S QUOTE NUMBER.
-- Test & Repair §4.
--
-- The owner asked for seven fields on the Test & Repair form. Three were
-- already there and are untouched: the fault description (which stays
-- OPTIONAL on this type — `requiresMachine`'s neighbour in the job-type
-- definition decides what a type must say, and a workshop repair is booked in
-- before the fault is diagnosed), the reference number, and the delivery note
-- (`capturesDeliveryNote` has been true for this type since it was written).
--
-- FOUR ARE NEW, and they are what this migration adds:
--
--   repair_part_number   what arrived, as it reads on the unit
--   repair_description   what it is, in the office's words
--   repair_quantity      how many
--   quote_number         the customer's quote reference
--
-- NOT THE SAME THING AS `job_parts`. That table is what was CONSUMED in the
-- repair and is priced; these columns are what was RECEIVED. A customer sends
-- in three identical sensors and EJE fit one new connector to each — two
-- separate facts about one job, and collapsing them would make the collection
-- note wrong in one direction or the invoice wrong in the other.
--
-- ALL OPTIONAL. The three text columns default to the empty string so every
-- existing job reads as "nobody filled this in" without a null-versus-empty
-- ambiguity, and the quantity stays NULLABLE because it is the one value that
-- can be genuinely absent — a zero would claim somebody counted nothing.
--
-- QUOTE NUMBER IS DELIBERATELY NOT OFFERED ON A PARTS COLLECTION. The owner
-- struck it out there. The column is on `jobs` because that is where a job's
-- fields live, and which types OFFER it is
-- `JobTypeDefinition.capturesQuoteNumber` — true for Test & Repair alone.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "repair_part_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "repair_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "repair_quantity" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "quote_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Replaced rather than added, per 0023: dropping first installs the definition
-- written here even on a database that already carries the name.
DO $$ BEGIN
	ALTER TABLE "jobs" DROP CONSTRAINT "jobs_repair_quantity_positive";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_repair_quantity_positive" CHECK (
	"repair_quantity" IS NULL OR "repair_quantity" > 0
);
