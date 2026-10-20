import { z } from 'zod';
import { asCustomerId } from '@/domain';
import { withdrawCustomerDocument } from '@/application/customer-documents';
import { writeRoute } from '@/server/api/handler';

/**
 * `POST /api/customers/:customerId/documents/:documentId/withdraw` —
 * take a document off the customer's screen. October mandate §4.
 *
 * WITHDRAWN, NEVER DELETED, and that is the register's own rule rather than a
 * new one: a site or a contact a job has named is archived, because the record
 * has to stay resolvable afterwards. A document that was attached when a
 * decision was taken is exactly such a record — the row stays, the bytes stay,
 * and an audit can still say what was on file.
 *
 * There is deliberately no DELETE. Nothing here removes a document's bytes,
 * because nothing here can know that the decision they informed will never be
 * questioned.
 */
export const POST = writeRoute({
  operation: 'customers.withdraw_document',
  schema: z.object({}).strict(),
  handler: async (context) => {
    const document = await withdrawCustomerDocument(
      context.operation,
      asCustomerId(context.params.customerId ?? ''),
      context.params.documentId ?? '',
    );
    const { storageKey: _storageKey, ...rest } = document;
    return { document: rest };
  },
});
