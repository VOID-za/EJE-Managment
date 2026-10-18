/**
 * Full-text matching, defined once for every backend. MASTER SCOPE LIB-5.
 *
 * WHY THIS EXISTS RATHER THAN A RULE PER ADAPTER. The library's search is
 * served from PostgreSQL in production and from the demonstration store on a
 * sales laptop, and a search that finds a manual in one and not the other is
 * not a search anybody can trust. So the RULE is here:
 *
 *   A document matches when EVERY term in the query appears in its text as a
 *   WHOLE WORD. No stemming, no fuzzy matching, no ranking cleverness.
 *
 * Whole words rather than substrings, because "oil" must not match "boiler" on
 * a page of maintenance instructions. No stemming, because PostgreSQL's
 * `simple` configuration — which is what the index uses — does not stem, and a
 * JavaScript stemmer on one side only would make the two backends disagree.
 * That is a deliberate, documented limitation: "megger" does not find
 * "meggered". A stemming configuration is a change to make on BOTH sides, with
 * the tests that prove they still agree.
 *
 * Words are split on anything that is not a letter or a digit, so a serial
 * number written `LW-V40-70214` is three words and is found by any of them —
 * which is how a technician searches: they remember part of it.
 */

/** The longest query worth running, and the longest single term. */
export const MAX_QUERY_LENGTH = 120;
const MAX_TERMS = 8;
/** One character matches half the library; two is the shortest useful term. */
export const MIN_TERM_LENGTH = 2;

const WORD_BREAK = /[^\p{L}\p{N}]+/u;

export const tokenize = (value: string): readonly string[] =>
  value
    .toLowerCase()
    .split(WORD_BREAK)
    .filter((word) => word.length > 0);

/**
 * The terms a query asks for, or an empty list when it asks for nothing useful.
 *
 * Capped at `MAX_TERMS`: a query is a person typing, and a thousand-term
 * request is either a mistake or an attempt to make the server work for
 * nothing.
 */
export const searchTerms = (query: string): readonly string[] => {
  const unique = new Set(
    tokenize(query.slice(0, MAX_QUERY_LENGTH)).filter((word) => word.length >= MIN_TERM_LENGTH),
  );
  return [...unique].slice(0, MAX_TERMS);
};

export const matchesAllTerms = (content: string, terms: readonly string[]): boolean => {
  if (terms.length === 0) return false;
  const words = new Set(tokenize(content));
  return terms.every((term) => words.has(term));
};

/**
 * Where in the document the words were found, in the words around them.
 *
 * A result without a snippet is a filename and a hope: the technician wants to
 * see that the manual really does talk about the alarm code before opening
 * fourteen megabytes on a tablet. The window is built around the first term
 * that is actually present, trimmed to whole words, and marked with an ellipsis
 * where text was cut so nobody reads a fragment as a complete sentence.
 */
export const snippetsFor = (
  content: string,
  terms: readonly string[],
  maximum = 2,
  radius = 90,
): readonly string[] => {
  const haystack = content.toLowerCase();
  const found: string[] = [];

  for (const term of terms) {
    if (found.length >= maximum) break;
    // Whole-word position, matching `matchesAllTerms` rather than a substring.
    const at = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').exec(
      haystack,
    );
    if (at === null) continue;

    const from = Math.max(0, at.index - radius);
    const to = Math.min(content.length, at.index + term.length + radius);
    const window = content.slice(from, to).replace(/\s+/g, ' ').trim();
    const prefix = from > 0 ? '… ' : '';
    const suffix = to < content.length ? ' …' : '';
    const snippet = `${prefix}${window}${suffix}`;
    if (!found.includes(snippet)) found.push(snippet);
  }
  return found;
};
