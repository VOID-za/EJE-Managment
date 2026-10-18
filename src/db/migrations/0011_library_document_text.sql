-- The technical library's full-text index. MASTER SCOPE LIB-5.
--
-- Until now the library could be searched by NAME, DESCRIPTION, MODEL,
-- MANUFACTURER and TAG — that is, by what somebody typed into the upload form.
-- A technician standing at a machine with an alarm code in front of them was
-- searching the filing labels rather than the manuals. This table holds the
-- text actually extracted from each uploaded PDF, so the words INSIDE a
-- document are searchable.
--
-- ONE ROW PER REVISION, keyed by the revision's own id — which is what
-- `library_documents` holds, because the domain's unit is a revision
-- (`addDocumentVersion` creates a new record and archives the old one). Two
-- consequences, both deliberate:
--
--   * a new revision indexes itself, and can neither inherit nor be shadowed
--     by the text of the revision it supersedes, so publishing a new manual
--     cannot leave the old words matching the new revision;
--   * ON DELETE CASCADE means a deleted document takes its searchable text with
--     it, rather than leaving words in the index pointing at nothing.
--
-- THE STATE IS A COLUMN, NOT AN ABSENCE. A scanned manual has no text in it at
-- all: it is `needs_ocr`, which is a fact the library SHOWS, so "this document
-- is not searchable yet" can be said instead of leaving a technician to
-- conclude the library holds nothing on that machine. `failed` carries the
-- reason — not a PDF, encrypted — because an extraction failure that is
-- dropped is a hole in the index nobody finds out about. The name records a
-- NEED: no OCR service is implied, and whether EJE ever pay for one is their
-- decision, not this migration's.
--
-- THE CHECKS MAKE THE STATE AND THE TEXT UNABLE TO DISAGREE: only `indexed` may
-- carry content, and `indexed` must carry some. A row claiming to be indexed
-- with nothing behind it is the one failure worth a constraint — it is the
-- state in which the search silently finds nothing and looks like it worked.
--
-- `search` is GENERATED ALWAYS from `content` with the `simple` configuration:
-- no stemming, whole words, which is the rule `src/lib/text-search.ts` states
-- and the demonstration store applies in JavaScript — so a search finds the
-- same manuals on either backend. Generated rather than application-maintained
-- so nothing can write a vector that disagrees with the text beside it, and
-- GIN-indexed, which is what makes this a search rather than a scan.
--
-- Additive: no existing table is altered and no existing row is touched.

CREATE TABLE "library_document_text" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"extracted_at" timestamp with time zone NOT NULL,
	"characters" integer DEFAULT 0 NOT NULL,
	"pages" integer DEFAULT 1 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"unreadable_streams" integer DEFAULT 0 NOT NULL,
	"failure_reason" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_document_text_state_matches_content" CHECK (("library_document_text"."state" = 'indexed' and length("library_document_text"."content") > 0)
          or ("library_document_text"."state" <> 'indexed' and "library_document_text"."content" = '')),
	CONSTRAINT "library_document_text_state_known" CHECK ("library_document_text"."state" in ('indexed', 'needs_ocr', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "library_document_text" ADD CONSTRAINT "library_document_text_document_id_library_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."library_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_document_text_search_idx" ON "library_document_text" USING gin ("search");--> statement-breakpoint
CREATE INDEX "library_document_text_state_idx" ON "library_document_text" USING btree ("state");