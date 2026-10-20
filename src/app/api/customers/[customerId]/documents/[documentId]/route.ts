import { NextResponse, type NextRequest } from 'next/server';
import { asCustomerId } from '@/domain';
import { readCustomerDocument } from '@/application/customer-documents';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { safeFileName } from '@/server/api/uploads';
import { getServerRuntime } from '@/server/runtime';

/**
 * `GET /api/customers/:customerId/documents/:documentId` — the file itself.
 * October mandate §4.
 *
 * AUTHORISATION BEFORE RETRIEVAL, and the storage key is never part of the
 * request: who is asking (session), may their role read this register at all
 * (`customers.manage`, inside the operation), and is this document THIS
 * customer's. Only then is anything read out of storage.
 *
 * EVERY REFUSAL IS THE SAME 404 — a document that does not exist, one
 * belonging to another customer, and one whose bytes are gone are
 * indistinguishable from outside, so the endpoint cannot be used to ask which
 * ids are real. A damaged file is the one exception and answers 422, because
 * "this exists and is corrupt" is information the office needs and an attacker
 * cannot provoke without already being authorised.
 *
 * ALWAYS AN ATTACHMENT, never inline: a PDF or an image rendered in the page
 * would run in this origin's context, and the one thing that must not happen
 * to a file somebody uploaded is that the browser treats it as part of this
 * application.
 */
export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ customerId: string; documentId: string }> },
): Promise<NextResponse> => {
  try {
    const { customerId, documentId } = await context.params;
    const actor = await requireAuthenticatedActor(request);

    const found = await getServerRuntime().read(async ({ repos, services }) => {
      const operation = { repos, services, actor: actor.user };
      return readCustomerDocument(operation, asCustomerId(customerId), documentId);
    });

    if (found === null) throw notFound('That document does not exist.');

    const fileName = safeFileName(found.document.fileName);
    return new NextResponse(found.file.bytes as unknown as BodyInit, {
      headers: {
        'content-type': found.file.contentType,
        'content-length': String(found.file.bytes.length),
        'content-disposition': `attachment; filename="${fileName}"`,
        // The sniffed type is the truth; the browser must not go looking for a
        // more interesting one.
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // A customer's paperwork is never cached by an intermediary.
        'cache-control': 'private, no-store',
      },
    });
  } catch (cause) {
    logUnexpected('customers.document', cause);
    return errorResponse(toApiError(cause));
  }
};
