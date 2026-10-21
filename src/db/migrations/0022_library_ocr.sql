-- TEXT RECOGNITION FOR SCANNED LIBRARY DOCUMENTS. MASTER SCOPE LIB-5.
--
-- TWO THINGS, AND THE FIRST IS THE HONEST ONE.
--
-- (1) `source` ON THE INDEX. Text lifted out of a PDF's own text layer is what
--     the document SAYS. Text produced by recognising pixels is a machine's
--     reading of what the document LOOKS LIKE, and on a scanned electrical
--     diagram it will contain mistakes — a `B` for an `8`, a missing minus sign
--     in a tolerance. A technician searching for an alarm code needs to know
--     which they are reading: one is evidence and the other is a hint. So the
--     row records it, and the search labels it.
--
--     DEFAULTED TO `text_layer` FOR EVERY EXISTING ROW, which is true of all of
--     them: until this migration there was no other way to get text.
--
--     The CHECK ties it to the state: only an `indexed` row has a source, and
--     every `indexed` row has one. The pair can never drift the way
--     `state`/`content` could not.
--
-- (2) `library_ocr_queue`. Lifting a text layer takes milliseconds and happens
--     inside the upload request. RECOGNISING a scanned page takes 5 to 15
--     seconds, so a 214-page manual is twenty minutes to an hour — inside an
--     HTTP request that timed out long ago, holding a transaction open, with
--     the office watching a spinner. The upload records that the document needs
--     recognition and RETURNS; the work is done afterwards by something allowed
--     to take as long as it takes.
--
--     ONE ROW PER REVISION, keyed by it, cascading with it: a deleted document
--     does not leave work behind for a document that no longer exists.
--
--     NO STATE HERE MEANS "SEARCHABLE". That question has exactly one answer,
--     `library_document_text.state`, and this table never duplicates it —
--     which is what stops the two disagreeing.
ALTER TABLE "library_document_text"
  ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint

UPDATE "library_document_text" SET "source" = 'text_layer' WHERE "state" = 'indexed' AND "source" IS NULL;--> statement-breakpoint

ALTER TABLE "library_document_text"
  ADD CONSTRAINT "library_document_text_source_matches_state"
  -- NULL-PROOF, AND THE FIRST VERSION WAS NOT. It read
  --
  --   (state = 'indexed' AND source IN ('text_layer','ocr'))
  --   OR (state <> 'indexed' AND source IS NULL)
  --
  -- and ACCEPTED an `indexed` row with a NULL source — the row it was written
  -- to refuse. `NULL IN (...)` is NULL, so the first arm is `true AND NULL` =
  -- NULL, the second is false, `NULL OR false` is NULL, and a CHECK treats
  -- NULL as satisfied. The SECOND time this trap has been hit here: the same
  -- shape refused nothing in `job_corrections` until `cardinality` replaced
  -- `array_length`. Found by the db test, which is why it is there.
  --
  -- Both halves below are boolean-valued whatever `source` is: an equality
  -- between two booleans, and a disjunction whose first arm is true on NULL.
  CHECK (
    ("state" = 'indexed') = ("source" IS NOT NULL)
    AND ("source" IS NULL OR "source" IN ('text_layer', 'ocr'))
  );--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "library_ocr_queue" (
  "document_id" uuid PRIMARY KEY NOT NULL,
  "state" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "queued_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "last_error" text NOT NULL DEFAULT '',
  "engine" text NOT NULL DEFAULT '',
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "library_ocr_queue_state_known"
    CHECK ("state" IN ('queued', 'running', 'done', 'failed', 'unavailable')),
  CONSTRAINT "library_ocr_queue_attempts_sane" CHECK ("attempts" >= 0),
  -- A claimed job has a start time, and an unclaimed one does not. Without
  -- this, a `running` row with no `started_at` could never be told from a
  -- worker that is still going, so the staleness rule would have nothing to
  -- measure and the document would be stuck for good.
  CONSTRAINT "library_ocr_queue_running_has_started"
    CHECK (("state" = 'running') = ("started_at" IS NOT NULL AND "finished_at" IS NULL)),
  -- A finished job says when. `queued` has neither time set.
  CONSTRAINT "library_ocr_queue_finished_when_settled"
    CHECK (
      ("state" IN ('done', 'failed', 'unavailable') AND "finished_at" IS NOT NULL)
      OR ("state" IN ('queued', 'running') AND "finished_at" IS NULL)
    )
);--> statement-breakpoint

ALTER TABLE "library_ocr_queue"
  ADD CONSTRAINT "library_ocr_queue_document_fk"
  FOREIGN KEY ("document_id") REFERENCES "public"."library_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "library_ocr_queue_state_idx" ON "library_ocr_queue" ("state", "queued_at");
