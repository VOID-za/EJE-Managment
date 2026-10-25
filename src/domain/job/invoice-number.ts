/**
 * WHAT COUNTS AS AN INVOICE NUMBER. Issue #73, Batch 1.
 *
 * EJE raise invoices in Sage, by hand; this system records the NUMBER. Pure and
 * in the domain so the Awaiting PO field and the server give the same answer.
 * No format is imposed beyond "something real": Sage's numbering is EJE's own,
 * and refusing a valid number because it does not match a guessed pattern
 * would be worse than accepting an odd one the office typed on purpose.
 */

/** The longest invoice number accepted. Sage numbers are short; this is generous. */
export const MAX_INVOICE_NUMBER_LENGTH = 60;

/** Null for a usable invoice number, otherwise the reason it is not one. */
export const invoiceNumberProblem = (value: string): string | null => {
  const number = value.trim();
  if (number.length === 0) {
    return 'Enter the invoice number from Sage. Without it the job stays Awaiting PO.';
  }
  if (number.length > MAX_INVOICE_NUMBER_LENGTH) {
    return `An invoice number is at most ${MAX_INVOICE_NUMBER_LENGTH} characters.`;
  }
  if (/[\u0000-\u001f\u007f]/u.test(number)) {
    return 'An invoice number cannot contain line breaks or control characters.';
  }
  return null;
};
