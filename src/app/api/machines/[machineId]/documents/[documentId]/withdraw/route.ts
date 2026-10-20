import { z } from 'zod';
import { asMachineId } from '@/domain';
import { withdrawMachineDocument } from '@/application/machine-documents';
import { writeRoute } from '@/server/api/handler';

/**
 * `POST /api/machines/:machineId/documents/:documentId/withdraw` —
 * take a document off the machine's screen. October mandate §4.
 *
 * WITHDRAWN, NEVER DELETED, the same rule as a customer's document and a
 * site: a compliance certificate that was on file when a machine was signed
 * off has to stay resolvable afterwards. The row stays, the bytes stay, and
 * there is deliberately no DELETE.
 */
export const POST = writeRoute({
  operation: 'machines.withdraw_document',
  schema: z.object({}).strict(),
  handler: async (context) => {
    const document = await withdrawMachineDocument(
      context.operation,
      asMachineId(context.params.machineId ?? ''),
      context.params.documentId ?? '',
    );
    const { storageKey: _storageKey, ...rest } = document;
    return { document: rest };
  },
});
