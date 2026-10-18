import 'server-only';
import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { z } from 'zod';
import type { OperationContext } from '@/application/context';
import { getServerRuntime, type UnitOfWork } from '@/server/runtime';
import { requireAuthenticatedActor, type AuthenticatedActor } from './actor';
import { assertSameOrigin } from './csrf';
import { ApiError, errorResponse, logUnexpected, toApiError } from './errors';
import { hashRequest, type IdempotencyScope } from './idempotency';
import { drainOutboxQuietly } from './outbox-dispatch';

/**
 * The shape every API route has.
 *
 * Written once, so no route can forget a step. The order matters and is the
 * same for every mutation:
 *
 *   same-origin → authenticate → validate → claim idempotency key
 *                → transaction → application operation → respond
 *
 * The route itself supplies only the last part. It never opens a transaction,
 * never touches two repositories by hand, and never decides who the actor is.
 */

/** JSON bodies are small. Anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 256 * 1024;

/** Next hands route parameters in as a promise; both wrappers resolve it first. */
export interface RouteParams {
  readonly params: Promise<Record<string, string>>;
}

export interface ReadContext extends UnitOfWork {
  readonly actor: AuthenticatedActor;
  readonly request: NextRequest;
  /** The dynamic segments of the URL, already resolved. */
  readonly params: Record<string, string>;
}

export interface WriteContext<TInput> extends ReadContext {
  readonly input: TInput;
  /** Ready to hand straight to an application operation. */
  readonly operation: OperationContext;
}

const jsonBody = async (request: NextRequest): Promise<unknown> => {
  const raw = await request.text();
  if (raw.length === 0) return {};
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new ApiError('validation_failed', 'That request is too large.');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError('validation_failed', 'The request body was not valid JSON.');
  }
};

/** Turns a schema failure into the field-level detail the screens already render. */
export const parseWith = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const violations = result.error.issues.slice(0, 20).map((issue) => ({
    code: issue.path.length === 0 ? 'invalid_request' : issue.path.join('.'),
    message: issue.message,
  }));
  throw new ApiError('validation_failed', 'Some of that could not be accepted.', violations);
};

const run = async (route: string, work: () => Promise<NextResponse>): Promise<NextResponse> => {
  try {
    return await work();
  } catch (cause) {
    logUnexpected(route, cause);
    return errorResponse(toApiError(cause));
  }
};

/**
 * A read.
 *
 * No transaction and no CSRF check: a GET changes nothing, and the same-origin
 * policy already stops another site reading the response. It IS authenticated,
 * because every read in this application is actor-aware.
 */
export const readRoute =
  <T>(route: string, handler: (context: ReadContext) => Promise<T>) =>
  async (request: NextRequest, routeContext?: RouteParams): Promise<NextResponse> =>
    run(route, async () => {
      const params = routeContext === undefined ? {} : await routeContext.params;
      const actor = await requireAuthenticatedActor(request);
      const runtime = getServerRuntime();
      const data = await runtime.read((unit) => handler({ ...unit, actor, request, params }));
      return NextResponse.json({ data });
    });

/**
 * A read whose answer is a FILE rather than JSON. MASTER SCOPE SEARCH-4.
 *
 * Everything `readRoute` does — authenticate, no transaction, no CSRF check on
 * a GET — and then a body with a file name on it instead of a `data` envelope.
 * It is a separate wrapper rather than a flag because the two answers are
 * different kinds of thing: one is parsed by the client's API layer, the other
 * is handed to the operating system by the browser.
 *
 * WHAT THE HEADERS ARE FOR, EACH OF THEM:
 *
 * - `Content-Disposition: attachment` with a file name, so the browser saves
 *   it rather than rendering it. The name is sent twice — the plain form for
 *   older clients and RFC 5987's `filename*` for anything non-ASCII — and
 *   quotes and control characters are stripped out of it, because a file name
 *   is the one part of this response a caller could have influenced.
 * - `X-Content-Type-Options: nosniff`, so a browser cannot decide a CSV is
 *   really HTML and run it.
 * - `Cache-Control: no-store`. These files are built from one person's
 *   authorised read; a shared cache must not hold one.
 */
export interface DownloadResponse {
  readonly fileName: string;
  readonly contentType: string;
  readonly body: string;
}

const safeFileName = (name: string): string =>
  name.replace(/["\\\r\n\u0000-\u001f]/g, '').slice(0, 120) || 'export';

export const downloadRoute =
  (route: string, handler: (context: ReadContext) => Promise<DownloadResponse>) =>
  async (request: NextRequest, routeContext?: RouteParams): Promise<NextResponse> =>
    run(route, async () => {
      const params = routeContext === undefined ? {} : await routeContext.params;
      const actor = await requireAuthenticatedActor(request);
      const runtime = getServerRuntime();
      const file = await runtime.read((unit) => handler({ ...unit, actor, request, params }));
      const name = safeFileName(file.fileName);
      return new NextResponse(file.body, {
        headers: {
          'Content-Type': file.contentType,
          'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    });

export interface WriteOptions<TInput, TResult> {
  /** Names the operation for idempotency and for the server log. */
  readonly operation: string;
  readonly schema: z.ZodType<TInput>;
  readonly handler: (context: WriteContext<TInput>) => Promise<TResult>;
}

/**
 * A mutation.
 *
 * `Idempotency-Key` is honoured when the client sends one. It is not required:
 * making it mandatory would break every ordinary form submission for the sake
 * of the retry case, and the client sends one exactly where a retry is
 * plausible.
 */
export const writeRoute =
  <TInput, TResult>({ operation, schema, handler }: WriteOptions<TInput, TResult>) =>
  async (request: NextRequest, routeContext?: RouteParams): Promise<NextResponse> =>
    run(operation, async () => {
      assertSameOrigin(request);
      const params = routeContext === undefined ? {} : await routeContext.params;
      const actor = await requireAuthenticatedActor(request);

      const body = await jsonBody(request);
      const input = parseWith(schema, body);

      const key = request.headers.get('idempotency-key');
      const runtime = getServerRuntime();

      const result = await runtime.write(async (unit) => {
        const scope: IdempotencyScope | null =
          key === null || key.length === 0
            ? null
            : { userId: actor.user.id, operation, key: key.slice(0, 200) };

        if (scope !== null) {
          const replayed = await unit.idempotency.claim(scope, hashRequest(body));
          // The first request already answered this. Hand back what it said.
          if (replayed !== null) return { data: replayed as TResult, replayed: true };
        }

        try {
          const data = await handler({
            ...unit,
            actor,
            request,
            params,
            input,
            operation: {
              repos: unit.repos,
              services: unit.services,
              // THE ACTOR COMES FROM THE SESSION. Nothing in `input` reaches it.
              actor: actor.user,
            },
          });

          if (scope !== null) {
            await unit.idempotency.complete(scope, data ?? null);
          }
          return { data, replayed: false };
        } catch (cause) {
          // In memory there is no transaction to roll the claim back, so a
          // failed operation has to release its key or it could never be
          // retried.
          if (scope !== null) unit.idempotency.release?.(scope);
          throw cause;
        }
      });

      /*
       * COMMITTED. NOW, and only now, anything leaves the building.
       *
       * The transaction above is closed: the assignment is recorded and so is
       * the obligation to tell somebody about it. This drains that obligation
       * outside any transaction, so a slow provider costs a moment of latency
       * rather than a database connection — and a provider that is down costs
       * nothing at all, because the row stays pending and the next mutation
       * tries again.
       *
       * Awaited deliberately. Fire-and-forget would return sooner and would
       * also be a promise nobody owns, which in a server that can be torn down
       * between requests is how a message quietly never goes.
       */
      await drainOutboxQuietly(runtime);

      return NextResponse.json(
        { data: result.data },
        { headers: result.replayed ? { 'Idempotent-Replay': 'true' } : undefined },
      );
    });

/**
 * A mutation that carries a FILE rather than JSON.
 *
 * Everything `writeRoute` does, in the same order, except that the body is
 * multipart and the validation of it is the upload's own — see `uploads.ts`,
 * which sniffs the bytes rather than believing the part's declared type.
 *
 * WHY A SEPARATE WRAPPER AND NOT A FLAG. The JSON path bounds the body at
 * 256 KB and parses it before authorising; neither is right for a 20 MB PDF.
 * Keeping them apart means the small, common path cannot accidentally inherit
 * a large body limit, and the upload path cannot accidentally inherit a parser
 * that would have to buffer the file as text first.
 *
 * IDEMPOTENCY IS HONOURED WHEN A KEY IS SENT, AND NEVER REQUIRED. *Amended for
 * the field-reliability batch; the original reasoning is kept because it was
 * right about the case it considered.* It read:
 *
 *   > NO IDEMPOTENCY KEY. A retried upload is a second attachment, which is
 *   > what the person asked for both times; replaying the first would silently
 *   > swallow a deliberate second copy of a document.
 *
 * That is true of two SEPARATE captures, and it stays true: each one mints its
 * own key, so both land. What it did not consider is one capture sent twice —
 * a tablet whose connection dropped after the bytes had been written but
 * before the answer came back, and a technician who then taps *Try again*. The
 * retry carries the SAME key, which is what makes the second attempt a replay
 * of the first rather than a duplicate photograph on a job card somebody is
 * about to sign.
 *
 * The key is scoped to the actor, the operation and the request's content — the
 * file's bytes included — so a key reused for a different photograph is
 * refused rather than quietly answering about the wrong one.
 */
export interface UploadContext extends ReadContext {
  readonly file: File;
  readonly caption: string;
  /**
   * The rest of the multipart body.
   *
   * For the fields that travel WITH a file and would otherwise need a second
   * request — a photograph's classification, for instance, which has to be
   * decided at the moment of capture. Every field is still a client claim and
   * is parsed and validated by the route, exactly like a JSON body.
   */
  readonly form: FormData;
  readonly operation: OperationContext;
}

export const uploadRoute =
  <TResult>({
    operation,
    maxBytes,
    handler,
  }: {
    readonly operation: string;
    readonly maxBytes: number;
    readonly handler: (context: UploadContext) => Promise<TResult>;
  }) =>
  async (request: NextRequest, routeContext?: RouteParams): Promise<NextResponse> =>
    run(operation, async () => {
      assertSameOrigin(request);
      const params = routeContext === undefined ? {} : await routeContext.params;
      const actor = await requireAuthenticatedActor(request);

      /*
       * Refused on the declared length BEFORE the body is read.
       *
       * Not a substitute for measuring the bytes — `Content-Length` is a claim
       * like any other and the real check is on what arrived — but it is what
       * stops a deliberately oversized request being buffered into memory
       * before anybody looks at it.
       */
      const declaredLength = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new ApiError('validation_failed', 'That file is too large.', [
          { code: 'file_too_large', message: 'The upload exceeds the size this accepts.' },
        ]);
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw new ApiError('validation_failed', 'That upload could not be read.', [
          { code: 'malformed_upload', message: 'Send the file as multipart form data.' },
        ]);
      }

      const file = form.get('file');
      if (!(file instanceof File)) {
        throw new ApiError('validation_failed', 'No file was attached to that request.', [
          { code: 'file_missing', message: 'Choose a file to attach.' },
        ]);
      }
      if (file.size > maxBytes) {
        throw new ApiError('validation_failed', 'That file is too large.', [
          { code: 'file_too_large', message: 'The upload exceeds the size this accepts.' },
        ]);
      }

      const caption = form.get('caption');
      const key = request.headers.get('idempotency-key');

      /*
       * The bytes, read ONCE, here.
       *
       * The handler reads them again through `file.arrayBuffer()`, which is
       * safe because a `File`'s contents can be read repeatedly — unlike the
       * request stream, which cannot. Hashing them is what makes the
       * idempotency key specific to this photograph: a key reused with a
       * different file is a client bug, and it is refused rather than answered
       * from the wrong record.
       */
      const fingerprint =
        key === null || key.length === 0
          ? null
          : hashRequest({
              fileName: file.name,
              size: file.size,
              caption: typeof caption === 'string' ? caption : '',
              fields: [...form.entries()]
                .filter(([, value]) => typeof value === 'string')
                .map(([name, value]) => [name, value as string])
                .sort(),
              bytes: createHash('sha256')
                .update(new Uint8Array(await file.arrayBuffer()))
                .digest('hex'),
            });

      const result = await getServerRuntime().write(async (unit) => {
        const scope: IdempotencyScope | null =
          key === null || key.length === 0 || fingerprint === null
            ? null
            : { userId: actor.user.id, operation, key: key.slice(0, 200) };

        if (scope !== null && fingerprint !== null) {
          const replayed = await unit.idempotency.claim(scope, fingerprint);
          // The first attempt already stored these bytes. Hand back what it
          // answered rather than attaching the same photograph twice.
          if (replayed !== null) return { data: replayed as TResult, replayed: true };
        }

        try {
          const data = await handler({
            ...unit,
            actor,
            request,
            params,
            file,
            form,
            caption: typeof caption === 'string' ? caption.slice(0, 500) : '',
            operation: {
              repos: unit.repos,
              services: unit.services,
              // THE ACTOR COMES FROM THE SESSION, here as everywhere else.
              actor: actor.user,
            },
          });
          if (scope !== null) await unit.idempotency.complete(scope, data ?? null);
          return { data, replayed: false };
        } catch (cause) {
          /*
           * In memory there is no transaction to roll the claim back, so a
           * failed upload has to release its key — otherwise a storage failure
           * would make that capture permanently unretryable, which is the
           * opposite of what the key is for. On PostgreSQL the marker is
           * written inside the request's transaction and rolls back with it.
           */
          if (scope !== null) unit.idempotency.release?.(scope);
          throw cause;
        }
      });

      return NextResponse.json(
        { data: result.data },
        { headers: result.replayed ? { 'Idempotent-Replay': 'true' } : undefined },
      );
    });
