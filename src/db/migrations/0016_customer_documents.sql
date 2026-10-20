-- A file attached to a CUSTOMER. October mandate §4.
--
-- Jobs, machines, checklists and the technical library all carry files; a
-- customer carried none, so a credit application, a signed service agreement,
-- a site induction certificate or a purchase-order authority had nowhere to
-- live. This is that table.
--
-- Its own table rather than a nullable job on `job_media`, for the reason
-- `machine_photos` is its own: a customer's document does not belong to a job
-- and is not printed on a job card, and a nullable foreign key would make
-- every query about job media have to remember to exclude these.
--
-- RESTRICT rather than cascade, and archived rather than deleted: a customer
-- with documents is a customer with history, and an audit has to be able to
-- resolve what was attached when a decision was taken.

CREATE TABLE "customer_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"content_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text,
	"uploaded_at" timestamp with time zone NOT NULL,
	"uploaded_by" uuid,
	"provenance" text DEFAULT 'genuine' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_documents_size_positive" CHECK ("customer_documents"."size_bytes" > 0),
	CONSTRAINT "customer_documents_provenance_known" CHECK ("customer_documents"."provenance" in ('genuine', 'simulated'))
);
--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_documents_customer_idx" ON "customer_documents" USING btree ("customer_id","uploaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_documents_storage_key_key" ON "customer_documents" USING btree ("storage_key");