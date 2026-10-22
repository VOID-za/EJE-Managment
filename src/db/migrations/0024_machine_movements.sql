-- WHERE A MACHINE HAS STOOD, AND SINCE WHEN. MACH-HIST.
--
-- WHAT THE REGISTER COULD NOT ANSWER. `machines.site_id` is the CURRENT site,
-- so "where is it" had an answer and "where was it" had none. A job finished
-- eighteen months ago resolves its machine and its site LIVE, which reads like
-- a record of where the work happened and is not one: the machine may have been
-- moved twice since. The job screen says so in words today, because there was
-- nothing better to say.
--
-- ONE ROW PER MOVE, carrying BOTH ENDS. A machine moving between a customer's
-- own sites and a machine sold to another customer are the same event to the
-- register and very different events to EJE, so the customer is recorded beside
-- the site at each end. Storing both ends means "where was it before" is one
-- row rather than a scan of every other row in order.
--
-- `effective_on` IS THE DAY IT MOVED, NOT THE DAY SOMEBODY TYPED IT. The office
-- learns about a move after the fact — a technician arrives and the machine is
-- in the next bay — and recording the typing date would put the machine in the
-- wrong place for however long the paperwork took.
--
-- APPEND-ONLY BY THE ABSENCE OF ANY UPDATE PATH. Nothing in the application
-- amends a movement, because a movement is something that happened; a move
-- recorded wrongly is corrected by recording the real one.
--
-- EVERY FOREIGN KEY RESTRICTS except the machine's own, which cascades: a
-- machine deleted outright (one no job was ever done on) takes its history with
-- it, and a SITE cannot be deleted out from under a movement that names it,
-- because the history would then say the machine moved somewhere that does not
-- exist.
--
-- NOTHING IS BACKFILLED. There is no record anywhere of where a machine stood
-- before today, and inventing an installation movement from `installation_date`
-- and the CURRENT site would assert that every machine has stood in its present
-- bay since the day it was installed — which is exactly the false history this
-- table exists to replace. The history starts empty and fills from the next
-- move, and `machineLocationAsAt` returns NULL for a date it cannot answer for.
CREATE TABLE IF NOT EXISTS "machine_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"from_site_id" uuid,
	"from_customer_id" uuid,
	"to_site_id" uuid NOT NULL,
	"to_customer_id" uuid NOT NULL,
	"effective_on" date NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_movements_moves_something" CHECK (
		("from_site_id" IS NULL AND "from_customer_id" IS NULL)
		OR "from_site_id" <> "to_site_id"
		OR "from_customer_id" <> "to_customer_id"
	),
	CONSTRAINT "machine_movements_from_is_whole" CHECK (
		("from_site_id" IS NULL) = ("from_customer_id" IS NULL)
	)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "machine_movements" ADD CONSTRAINT "machine_movements_machine_id_machines_id_fk"
		FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "machine_movements" ADD CONSTRAINT "machine_movements_from_site_id_sites_id_fk"
		FOREIGN KEY ("from_site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "machine_movements" ADD CONSTRAINT "machine_movements_from_customer_id_customers_id_fk"
		FOREIGN KEY ("from_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "machine_movements" ADD CONSTRAINT "machine_movements_to_site_id_sites_id_fk"
		FOREIGN KEY ("to_site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "machine_movements" ADD CONSTRAINT "machine_movements_to_customer_id_customers_id_fk"
		FOREIGN KEY ("to_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "machine_movements" ADD CONSTRAINT "machine_movements_recorded_by_users_id_fk"
		FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_movements_machine_idx" ON "machine_movements" USING btree ("machine_id","effective_on");
