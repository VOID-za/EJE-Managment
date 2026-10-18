-- A technician's report that the register is wrong, and what the office did
-- about it. MASTER SCOPE CUST-CR.
--
-- The refusal promised this table months ago: a technician's customer edit is
-- refused with "Technicians can view customers and raise change requests, but
-- not edit them", and the machine register says the same. There was nowhere to
-- raise one, so somebody standing in front of a machine whose serial number is
-- wrong could read that they may report it and had no way to.
--
-- NOTHING HERE APPLIES ITSELF, and the absence of a proposed-value column is
-- deliberate rather than unfinished. A structured "change the serial to X" the
-- system could apply needs EJE to answer who may approve what, and whether an
-- approved change reaches the jobs already carried out on that machine
-- (MACH-HIST). Neither is settled, so this carries the technician's WORDS and
-- the office's DECISION; the office edits the register through the screens that
-- already authorise it.
--
-- Every foreign key is RESTRICT: a report is history, and deleting the record
-- it is about to make the report disappear is the one thing that must not be
-- possible.
CREATE TABLE "customer_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"machine_id" uuid,
	"details" text NOT NULL,
	"raised_by" uuid,
	"raised_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_change_requests_details_present" CHECK (length(btrim("customer_change_requests"."details")) > 0),
	CONSTRAINT "customer_change_requests_resolved_is_attributed" CHECK (("customer_change_requests"."state" = 'open') = ("customer_change_requests"."resolved_at" is null)),
	CONSTRAINT "customer_change_requests_resolver_recorded" CHECK ("customer_change_requests"."resolved_at" is null or "customer_change_requests"."resolved_by" is not null)
);
--> statement-breakpoint
ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_change_requests" ADD CONSTRAINT "customer_change_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_change_requests_state_idx" ON "customer_change_requests" USING btree ("state","raised_at");--> statement-breakpoint
CREATE INDEX "customer_change_requests_customer_idx" ON "customer_change_requests" USING btree ("customer_id","raised_at");--> statement-breakpoint
CREATE INDEX "customer_change_requests_raised_by_idx" ON "customer_change_requests" USING btree ("raised_by","raised_at");