-- AN ACCOUNT NOTE CAN BE WRITTEN, AND CORRECTED. Customers §2.
--
-- `customer_notes` has existed since 0000 and nothing could ever write to it:
-- the table was populated by the demonstration seed, rendered on the customer
-- screen and persisted by the repository's `replaceNotes`, but there was no
-- operation, no route and no control that added one. The office asked to keep
-- account notes and could not.
--
-- Adding a note needs no schema change. EDITING one does, and these two columns
-- are the whole of it: who corrected the note and when. `author_id` and
-- `created_at` are deliberately NOT touched by an edit — they say who wrote the
-- note and when, which an edit does not change — so a screen can show new words
-- while still naming the person who wrote the original.
--
-- Both nullable, because a note nobody has edited has no editor, and
-- all-or-nothing, because a timestamp with nobody against it (or the reverse)
-- is half a record. The equivalence is written NULL-proof: a NULL inside a
-- CHECK reads as satisfied, so `edited_by IS NOT NULL = edited_at IS NOT NULL`
-- is the form that actually refuses the broken halves.
ALTER TABLE "customer_notes" ADD COLUMN IF NOT EXISTS "edited_by" uuid;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_edited_by_users_id_fk"
		FOREIGN KEY ("edited_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Replaced rather than added (see 0023): dropping first is what installs the
-- definition written here even on a database that already has the name.
DO $$ BEGIN
	ALTER TABLE "customer_notes" DROP CONSTRAINT "customer_notes_edit_is_whole_or_absent";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_edit_is_whole_or_absent" CHECK (
	("edited_by" IS NOT NULL) = ("edited_at" IS NOT NULL)
);
