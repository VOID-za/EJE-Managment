-- Documents about ONE machine. October mandate §4.
--
-- `machine_photos` holds pictures of the machine as it stands; the technical
-- library holds EJE's reference material, filed by manufacturer and MODEL.
-- Neither of them can hold a commissioning report, a compliance certificate or
-- a laser-calibration result for one serial number: a photograph table would
-- render a PDF as a broken image, and the library would make the document
-- answer for every other machine of that model.
--
-- `audience` is MEDIA-1's question asked about machine paperwork — who is this
-- for — and it defaults to `office_only`, which is the safe direction. A
-- manual somebody forgot to classify is an inconvenience; an invoice shown to
-- the field is a disclosure.
--
-- CASCADE, unlike `customer_documents`. A machine with job history is archived
-- rather than deleted, so the delete this key governs only ever reaches a
-- machine nothing refers to — an entry somebody created by mistake — and its
-- paperwork should go with it, exactly as its photographs and approvals do.

CREATE TABLE "machine_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"machine_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"content_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text,
	"audience" text DEFAULT 'office_only' NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"uploaded_by" uuid,
	"provenance" text DEFAULT 'genuine' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_documents_size_positive" CHECK ("machine_documents"."size_bytes" > 0),
	CONSTRAINT "machine_documents_audience_known" CHECK ("machine_documents"."audience" in ('field', 'office_only')),
	CONSTRAINT "machine_documents_provenance_known" CHECK ("machine_documents"."provenance" in ('genuine', 'simulated'))
);
--> statement-breakpoint
ALTER TABLE "machine_documents" ADD CONSTRAINT "machine_documents_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_documents" ADD CONSTRAINT "machine_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_documents_machine_idx" ON "machine_documents" USING btree ("machine_id","uploaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_documents_storage_key_key" ON "machine_documents" USING btree ("storage_key");
