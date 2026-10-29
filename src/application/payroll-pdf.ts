import { OnePageOverflow } from '@/services/simulated/one-page-form';
import { WorkflowError } from './errors';

/**
 * Renders a payroll form, turning "cannot fit on one page" into a plain
 * refusal the screen can show (PAY-04) — never a second page, never cut rows.
 */
export const onePageOrRefuse = <T extends { readonly pageCount: number }>(render: () => T): T => {
  try {
    const rendered = render();
    if (rendered.pageCount !== 1) throw new Error(`a payroll form rendered ${rendered.pageCount} pages`);
    return rendered;
  } catch (cause) {
    if (cause instanceof OnePageOverflow) {
      throw new WorkflowError('This form does not fit on one page.', [
        { code: 'form_too_long_for_one_page', message: `${cause.message} Shorten the longest comments or notes, then try again.` },
      ]);
    }
    throw cause;
  }
};
