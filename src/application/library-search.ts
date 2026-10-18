import { can, type DocumentTextIndex, type TechnicalDocument, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import {
  MAX_QUERY_LENGTH,
  MIN_TERM_LENGTH,
  searchTerms,
  snippetsFor,
} from '@/lib/text-search';
import { WorkflowError } from './errors';

/**
 * SEARCHING INSIDE THE DOCUMENTS. MASTER SCOPE LIB-5.
 *
 * WHAT WAS THERE BEFORE, AND WHY IT WAS NOT A FULL-TEXT SEARCH. The library
 * matched a term against the NAME, DESCRIPTION, MODEL, MANUFACTURER and TAGS —
 * the fields somebody typed into the upload form. A technician standing at a
 * machine with alarm code 414 on the screen was searching the filing labels,
 * and the one place the answer actually lives — page 212 of the drive manual —
 * was not searched at all. This searches the extracted text of the documents
 * themselves.
 *
 * AUTHORISATION, AND IT IS THE SAME ANSWER AS EVERY OTHER LIBRARY READ:
 *
 *  1. `library.view` or nothing. The capability that governs reading the
 *     library governs searching it, decided HERE rather than by whichever
 *     screen asked.
 *  2. ONLY CURRENT DOCUMENTS ARE SEARCHABLE — for everybody, Masters included.
 *     A `pending_approval` upload is not official reference material (a
 *     technician could otherwise follow a manual nobody has checked), and an
 *     `archived` revision has been withdrawn: it stays readable through the
 *     job that referenced it, which is a different question from whether it
 *     should surface as an answer today. A Master reviews pending uploads in
 *     Administration, where the context says what they are.
 *  3. THE INDEX IS NEVER CONSULTED FOR A DOCUMENT THIS ACTOR MAY NOT SEE. The
 *     candidate set is computed from the documents first and passed into the
 *     repository, so a snippet cannot be produced from a document that was
 *     filtered out afterwards — snippets, metadata and the download all answer
 *     to the same rule.
 *
 * WHAT A RESULT CARRIES. The document as the library already shows it, where
 * the words were found, and — on the page actually being shown — the text
 * around them. The snippet comes from the stored text of THAT revision, read
 * one row at a time, so a result page never pulls every manual into memory.
 *
 * WHAT IS NOT SEARCHABLE, SAID OUT LOUD. A scanned manual has no text in it:
 * it is `needs_ocr`, and the answer carries how many such documents exist so
 * the screen can say "3 documents in this library are not searchable yet"
 * rather than letting a technician conclude EJE holds nothing on that machine.
 */
export interface LibrarySearchHit {
  readonly document: TechnicalDocument;
  /** Where the words were found, in the words around them. */
  readonly snippets: readonly string[];
  readonly index: DocumentTextIndex;
}

export interface LibrarySearchPage {
  readonly terms: readonly string[];
  readonly hits: readonly LibrarySearchHit[];
  /** How many documents matched in total, before this page was cut from them. */
  readonly matched: number;
  readonly page: number;
  readonly pageSize: number;
  /**
   * Documents this actor may search that hold no searchable text.
   *
   * Reported rather than hidden: it is the difference between "there is nothing
   * about that alarm in the library" and "there are manuals nobody can search".
   */
  readonly notSearchable: {
    readonly needsOcr: number;
    readonly failed: number;
    readonly notIndexed: number;
  };
}

export const LIBRARY_SEARCH_PAGE_SIZE = 10;
/** More than this and the office is browsing, not searching. */
const MAX_MATCHES = 200;
const MAX_PAGE = 20;

export interface LibrarySearchQuery {
  readonly term: string;
  /** One-based, like the screen. */
  readonly page: number;
}

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

export const searchLibraryText = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'id' | 'role'>,
  query: LibrarySearchQuery,
  pageSize: number = LIBRARY_SEARCH_PAGE_SIZE,
): Promise<LibrarySearchPage> => {
  if (!can(actor.role, 'library.view')) {
    throw refuse(
      'The technical library is not available to this account.',
      'not_permitted',
      'Reading the library is what allows searching it; they are the same read.',
    );
  }

  /*
   * THE QUERY IS VALIDATED, NOT TRIMMED INTO SOMETHING ELSE.
   *
   * A single character matches half a library and would return a page of
   * noise; an empty query is not a search. Both are refused with what to do
   * instead, rather than answered with an arbitrary result — and the length cap
   * is what stops a thousand-term query becoming free server time.
   */
  if (query.term.length > MAX_QUERY_LENGTH) {
    throw refuse(
      'That search is too long.',
      'query_too_long',
      `Search for up to ${MAX_QUERY_LENGTH} characters — a phrase from the manual, not the manual.`,
    );
  }
  if (query.page < 1 || query.page > MAX_PAGE || !Number.isInteger(query.page)) {
    throw refuse(
      'That page of results does not exist.',
      'page_out_of_range',
      `Results run from page 1 to page ${MAX_PAGE}. Narrow the search instead of paging through everything.`,
    );
  }

  const terms = searchTerms(query.term);
  if (terms.length === 0) {
    throw refuse(
      'There is nothing to search for.',
      'query_too_short',
      `Type at least ${MIN_TERM_LENGTH} characters of a word that would appear in the document.`,
    );
  }

  const documents = await repos.documents.list();
  // Rule 2: only current revisions are answers. Nothing else reaches the index.
  const searchable = documents.filter((document) => document.status === 'current');
  const byId = new Map(searchable.map((document) => [document.id, document]));

  const [matches, states] = await Promise.all([
    repos.documents.searchTextIds(
      terms,
      searchable.map((document) => document.id),
      MAX_MATCHES,
    ),
    repos.documents.listTextIndexes(searchable.map((document) => document.id)),
  ]);

  const stateById = new Map(states.map((state) => [state.documentId, state]));
  const notSearchable = {
    needsOcr: states.filter((state) => state.state === 'needs_ocr').length,
    failed: states.filter((state) => state.state === 'failed').length,
    notIndexed: searchable.filter((document) => !stateById.has(document.id)).length,
  };

  const from = (query.page - 1) * pageSize;
  const window = matches.slice(from, from + pageSize);

  /*
   * The text is read ONLY for the rows on this page.
   *
   * A manual's text is hundreds of thousands of characters; reading every
   * match's text to show ten of them is how a search that works in a
   * demonstration falls over on a real library.
   */
  const hits: LibrarySearchHit[] = [];
  for (const documentId of window) {
    const document = byId.get(documentId);
    const index = stateById.get(documentId);
    if (document === undefined || index === undefined) continue;
    const content = await repos.documents.findTextContent(documentId);
    hits.push({
      document,
      index,
      snippets: content === null ? [] : snippetsFor(content, terms),
    });
  }

  return {
    terms,
    hits,
    matched: matches.length,
    page: query.page,
    pageSize,
    notSearchable,
  };
};
