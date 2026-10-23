-- LIB-TEXT-1: ordinary PDF text extraction, page by page.
--
-- WHY. EJE's library will hold manufacturer manuals, not scanned paperwork, so
-- extracting the text a PDF already contains is the PRIMARY search path. The
-- built-in byte reader cannot read a manual whose fonts are subset with
-- Identity-H encoding -- which is what Acrobat, InDesign and FrameMaker all
-- produce -- and reported every such document as a scan needing recognition at
-- 23-25 seconds a page. `pdftotext` reads them, and reads them PER PAGE.
--
-- Three changes, and each one is a fact the old shape could not hold:
--
--   1. `pages_indexed` on the document index, so "searchable" carries how much
--      of the document is searchable.
--   2. A `partially_indexed` state and a `mixed` source, for the ordinary case
--      of a typeset manual with a scanned diagram in it.
--   3. `library_document_pages`, one row per page that has text, carrying its
--      own provenance and its own full-text vector.
--
-- NOTHING IS REWRITTEN. Every existing row is a whole-document extraction from
-- a text layer, so `pages_indexed` is backfilled to `pages` for the rows that
-- are `indexed` and left at zero for the rest -- which is exactly what those
-- rows already meant.

ALTER TABLE "library_document_text"
  ADD COLUMN IF NOT EXISTS "pages_indexed" integer DEFAULT 0 NOT NULL;

-- The backfill BEFORE the CHECK that depends on it, or the CHECK would refuse
-- every existing indexed row.
UPDATE "library_document_text" SET "pages_indexed" = "pages" WHERE "state" = 'indexed';

/*
 * THE THREE REPLACED CHECKS: QUIET DROP, THEN AN UNCONDITIONAL ADD.
 *
 * `DO ... EXCEPTION WHEN duplicate_object THEN NULL` is right for a NEW
 * constraint and WRONG for a replaced one: on a database that already carries
 * the old definition it swallows the error and KEEPS THE OLD RULE, so the
 * migration reports success and the constraint still refuses what the new code
 * writes. `redefinitions.test.ts` is the lint that holds this rule.
 */
DO $$ BEGIN
  ALTER TABLE "library_document_text" DROP CONSTRAINT "library_document_text_state_known";
EXCEPTION WHEN undefined_object THEN NULL; END $$;

ALTER TABLE "library_document_text" ADD CONSTRAINT "library_document_text_state_known"
  CHECK ("state" in ('indexed', 'partially_indexed', 'needs_ocr', 'failed'));

DO $$ BEGIN
  ALTER TABLE "library_document_text" DROP CONSTRAINT "library_document_text_source_matches_state";
EXCEPTION WHEN undefined_object THEN NULL; END $$;

ALTER TABLE "library_document_text" ADD CONSTRAINT "library_document_text_source_matches_state"
  CHECK (
    ("state" in ('indexed', 'partially_indexed')) = ("source" is not null)
    and ("source" is null or "source" in ('text_layer', 'ocr', 'mixed'))
  );

DO $$ BEGIN
  ALTER TABLE "library_document_text" DROP CONSTRAINT "library_document_text_state_matches_content";
EXCEPTION WHEN undefined_object THEN NULL; END $$;

ALTER TABLE "library_document_text" ADD CONSTRAINT "library_document_text_state_matches_content"
  CHECK (
    ("state" in ('indexed', 'partially_indexed') and length("content") > 0)
    or ("state" not in ('indexed', 'partially_indexed') and "content" = '')
  );

-- NEW, so the duplicate-safe form is the right one here.
DO $$ BEGIN
  ALTER TABLE "library_document_text"
    ADD CONSTRAINT "library_document_text_pages_indexed_matches_state"
    CHECK (
      ("state" = 'indexed' and "pages_indexed" = "pages")
      or ("state" = 'partially_indexed' and "pages_indexed" > 0 and "pages_indexed" < "pages")
      or ("state" not in ('indexed', 'partially_indexed') and "pages_indexed" = 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "library_document_pages" (
  "document_id" uuid NOT NULL,
  "page_number" integer NOT NULL,
  "source" text NOT NULL,
  "characters" integer NOT NULL,
  "content" text NOT NULL,
  -- GENERATED from `content`, so nothing can ever write a vector that
  -- disagrees with the text it indexes. `simple`, not `english`: no stemming,
  -- which is the rule `src/lib/text-search.ts` states and the demonstration
  -- store applies in JavaScript, so the two backends agree about what matches.
  "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  "extracted_at" timestamp with time zone NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "library_document_pages"
    ADD CONSTRAINT "library_document_pages_document_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "library_documents"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "library_document_pages"
    ADD CONSTRAINT "library_document_pages_numbered_from_one" CHECK ("page_number" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "library_document_pages"
    ADD CONSTRAINT "library_document_pages_source_known"
    CHECK ("source" in ('text_layer', 'ocr'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "library_document_pages"
    ADD CONSTRAINT "library_document_pages_content_present" CHECK (length("content") > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "library_document_pages"
    ADD CONSTRAINT "library_document_pages_characters_sane" CHECK ("characters" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "library_document_pages_pkey"
  ON "library_document_pages" ("document_id", "page_number");

CREATE INDEX IF NOT EXISTS "library_document_pages_search_idx"
  ON "library_document_pages" USING gin ("search");
