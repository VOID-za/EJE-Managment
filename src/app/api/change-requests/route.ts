import { z } from 'zod';
import { CHANGE_REQUEST_DETAILS_LIMIT } from '@/domain';
import {
  listChangeRequests,
  listMyChangeRequests,
  raiseChangeRequest,
} from '@/application/change-request-operations';
import { readRoute, writeRoute } from '@/server/api/handler';

/**
 * `GET /api/change-requests` — reports that the register is wrong. CUST-CR.
 *
 * TWO AUDIENCES, ONE ROUTE, AND THE SERVER DECIDES WHICH — the same shape as
 * `/api/captures/referrals`, because it is the same workflow. `?mine=1` answers
 * the actor's OWN reports, which is how a technician learns what the office did
 * about the serial number they said was wrong. Without it the route answers
 * every report, and that needs `customers.manage`.
 *
 * The scoping lives in the operations, not here, so there is one place that
 * decides who may read what.
 */
export const GET = readRoute('customers.changeRequests', async (context) => {
  const url = new URL(context.request.url);
  const mine = url.searchParams.get('mine') === '1';
  const state = url.searchParams.get('state');

  // A read performs no operation, so one is composed from the unit of work and
  // the SESSION's actor. The actor is never taken from the request.
  const operation = {
    repos: context.repos,
    services: context.services,
    actor: context.actor.user,
  };

  const rows = mine
    ? await listMyChangeRequests(operation)
    : await listChangeRequests(operation, {
        ...(state === 'open' || state === 'applied' || state === 'declined' ? { state } : {}),
      });
  return { rows };
});

/**
 * Raising one.
 *
 * `subject` says which kind of record is wrong and the ids say which one. Every
 * one of them is a claim from a browser, so `raiseChangeRequest` resolves each
 * and checks that the pair belongs together — a report about another customer's
 * machine would file a problem against a record nobody can act on.
 */
export const POST = writeRoute({
  operation: 'customers.raiseChangeRequest',
  schema: z
    .object({
      subject: z.enum(['customer', 'site', 'machine', 'job']),
      customerId: z.string().min(1).max(100),
      siteId: z.string().min(1).max(100).nullable().optional(),
      machineId: z.string().min(1).max(100).nullable().optional(),
      /*
       * CUST-CR, THE JOB HALF. The job a CUSTOMER has asked for something on,
       * and which of their contacts asked. Both resolved and checked by the
       * operation — a job id from a browser is a claim like any other, and a
       * request filed against another customer's job would put one customer's
       * words on another's job card.
       */
      jobId: z.string().min(1).max(100).nullable().optional(),
      requestedByContactId: z.string().min(1).max(100).nullable().optional(),
      details: z.string().min(1).max(CHANGE_REQUEST_DETAILS_LIMIT),
    })
    .strict(),
  handler: async (context) =>
    raiseChangeRequest(context.operation, {
      subject: context.input.subject,
      customerId: context.input.customerId as never,
      ...(context.input.siteId === undefined
        ? {}
        : { siteId: context.input.siteId as never }),
      ...(context.input.machineId === undefined
        ? {}
        : { machineId: context.input.machineId as never }),
      ...(context.input.jobId === undefined ? {} : { jobId: context.input.jobId as never }),
      ...(context.input.requestedByContactId === undefined
        ? {}
        : { requestedByContactId: context.input.requestedByContactId as never }),
      details: context.input.details,
    }),
});
