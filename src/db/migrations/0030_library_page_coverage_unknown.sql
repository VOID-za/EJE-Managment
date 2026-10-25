-- LIB-TEXT-1 (#70): a partial index may say its page coverage is UNKNOWN.
--
-- WHY. `0029` required a `partially_indexed` row to name between 1 and
-- pages-1 indexed pages. That is right for an engine that reads per page, and
-- it left nothing truthful to write for the one that cannot: the built-in
-- reader (used only where poppler-utils is missing) keeps a bounded prefix of
-- a document's text and cannot tell which pages it came from. Faced with that,
-- the code recorded such a document as `indexed`, every page counted — the
-- overstatement the state exists to prevent.
--
-- WHAT CHANGES. `partially_indexed` may now carry `pages_indexed = 0`, which
-- the application reads as "some of this document is searchable; which pages
-- is not known". Nothing else moves: `indexed` still means every page, and
-- every other state still carries zero.
--
-- ADDITIVE. The new rule accepts every row the old one did, so no existing row
-- can fail it. Written as a QUIET DROP and an UNCONDITIONAL ADD, because this
-- REPLACES a constraint `0029` defined — see `redefinitions.test.ts` for why
-- `EXCEPTION WHEN duplicate_object` would keep the old rule.

DO $$ BEGIN
  ALTER TABLE "library_document_text" DROP CONSTRAINT "library_document_text_pages_indexed_matches_state";
EXCEPTION WHEN undefined_object THEN NULL; END $$;

ALTER TABLE "library_document_text"
  ADD CONSTRAINT "library_document_text_pages_indexed_matches_state"
  CHECK (
    ("state" = 'indexed' and "pages_indexed" = "pages")
    or ("state" = 'partially_indexed' and "pages_indexed" >= 0 and "pages_indexed" < "pages")
    or ("state" not in ('indexed', 'partially_indexed') and "pages_indexed" = 0)
  );
