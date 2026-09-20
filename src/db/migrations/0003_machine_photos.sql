-- Photographs of a machine, as rows.
--
-- The demo carries `Machine.photos` inline on the machine record and the
-- machine screen renders them, so persisting a machine without them would drop
-- captured data on the floor. They get a table for the same reason job media
-- does: each photo has its own uploader, its own timestamp and its own file
-- behind `StorageService`, and the bytes never live in this database.
--
-- Additive only. Nothing in 0000, 0001 or 0002 is touched.

CREATE TABLE "machine_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"machine_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text DEFAULT '' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_photos" ADD CONSTRAINT "machine_photos_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_photos" ADD CONSTRAINT "machine_photos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_photos_machine_idx" ON "machine_photos" USING btree ("machine_id","uploaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_photos_storage_key_key" ON "machine_photos" USING btree ("storage_key");
