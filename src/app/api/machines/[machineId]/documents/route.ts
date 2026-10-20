import { z } from 'zod';
import { asMachineId } from '@/domain';
import {
  asMachineDocumentAudience,
  attachMachineDocument,
  listMachineDocuments,
} from '@/application/machine-documents';
import { ApiError } from '@/server/api/errors';
import { readRoute, uploadRoute } from '@/server/api/handler';
import { MAX_UPLOAD_BYTES, validateUpload } from '@/server/api/uploads';

/**
 * `GET /api/machines/:machineId/documents` — the paper filed against this
 * machine. `POST` — attach a file to it. October mandate §4.
 *
 * AUTHORISATION IS THE OPERATION'S, not this file's, and it is not the same
 * rule at both ends: attaching needs `machines.manage`, while READING depends
 * on the document — the office reads everything, and a technician reads what
 * the office marked for the field. `listMachineDocuments` applies that, so a
 * technician's response does not carry an office-only document at all.
 *
 * THE ORDER on an upload, and every step of it matters:
 *
 *   same-origin → authenticate → bound the body → sniff the BYTES →
 *   does this machine exist and may it take a document →
 *   store the bytes → read them back → record the row → commit
 */
const FIELDS = z
  .object({
    /**
     * Who may read it. A CLAIM from a form, parsed into the domain's two
     * values; anything else — absent, misspelt, invented — becomes
     * `office_only`, which is the direction that cannot disclose anything.
     */
    audience: z.enum(['field', 'office_only']).optional(),
  })
  .strict();

export const GET = readRoute('machines.documents', async (context) => {
  const operation = {
    repos: context.repos,
    services: context.services,
    actor: context.actor.user,
  };
  const documents = await listMachineDocuments(
    operation,
    asMachineId(context.params.machineId ?? ''),
  );
  // The storage key stays on the server: the download route resolves it after
  // deciding who is asking, and a key is not a way in.
  return {
    documents: documents.map(({ storageKey: _storageKey, ...rest }) => rest),
  };
});

export const POST = uploadRoute({
  operation: 'machines.attach_document',
  maxBytes: MAX_UPLOAD_BYTES,
  handler: async (context) => {
    const parsed = FIELDS.safeParse(
      context.form.has('audience') ? { audience: context.form.get('audience') } : {},
    );
    if (!parsed.success) {
      throw new ApiError('validation_failed', 'That document could not be attached.', [
        {
          code: 'invalid_field',
          message: 'Say who the document is for: the field, or the office only.',
        },
      ]);
    }

    const file = validateUpload({
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    });

    const saved = await attachMachineDocument(
      context.operation,
      asMachineId(context.params.machineId ?? ''),
      {
        ...file,
        caption: context.caption,
        audience: asMachineDocumentAudience(parsed.data.audience),
      },
    );

    const { storageKey: _storageKey, ...document } = saved;
    return { document };
  },
});
