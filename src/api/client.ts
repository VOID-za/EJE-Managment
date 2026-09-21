'use client';

import type { RuleViolation } from '@/domain';

/**
 * The browser's only way to reach anything.
 *
 * There is no other. The client bundle contains no repository, no Drizzle, no
 * connection string and no user id it chose for itself — it sends an
 * authenticated request and is served whatever the server decides it may have.
 *
 * `credentials: 'same-origin'` rather than `include`: the session cookie is for
 * this origin and travels nowhere else.
 */
export type ApiErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'rate_limited'
  | 'workflow_refused'
  | 'internal_error'
  | 'network';

/**
 * A refusal from the server, with the detail the screens already render.
 *
 * `violations` is the same list `WorkflowError` carries in the application
 * layer, passed through unchanged — which is why `RuleViolationNotice` keeps
 * working without knowing an HTTP request happened.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly violations: readonly RuleViolation[] = [],
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** True when the session has ended and the person has to sign in again. */
export const isAuthenticationFailure = (cause: unknown): boolean =>
  cause instanceof ApiRequestError && cause.code === 'unauthenticated';

/**
 * True when the server says there is no such record.
 *
 * Which, for anything the actor may not read, is the SAME answer as a record
 * that never existed — deliberately, so the response cannot be used to ask
 * which job numbers are real. A screen treats both as "not found".
 */
export const isNotFound = (cause: unknown): boolean =>
  cause instanceof ApiRequestError && cause.code === 'not_found';

interface Envelope<T> {
  readonly data?: T;
  readonly error?: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly violations?: readonly RuleViolation[];
  };
}

/** Listeners told when the server says the session has ended. */
const sessionListeners = new Set<() => void>();

export const onSessionEnded = (listener: () => void): (() => void) => {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
};

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly body?: unknown;
  /**
   * Makes a retry safe.
   *
   * Sent for anything a person would plausibly tap twice on a bad signal. The
   * server does the work once and hands the same answer back to the retry.
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const method = options.method ?? 'GET';
  let response: Response;

  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { 'idempotency-key': options.idempotencyKey }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    /*
     * The network, not the server.
     *
     * Said plainly rather than swallowed. This phase is ONLINE-FIRST: nothing
     * is queued, nothing is written to local storage, and nobody is told a
     * capture succeeded when it never left the tablet. Offline support is its
     * own phase and will be built deliberately.
     */
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiRequestError(
      'network',
      'No connection to the EJE server. Your change has not been saved.',
    );
  }

  let envelope: Envelope<T>;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    throw new ApiRequestError(
      'internal_error',
      'The server sent something this application could not read.',
    );
  }

  if (!response.ok || envelope.error !== undefined) {
    const error = envelope.error;
    const code: ApiErrorCode = error?.code ?? 'internal_error';
    if (code === 'unauthenticated') {
      for (const listener of sessionListeners) listener();
    }
    throw new ApiRequestError(
      code,
      error?.message ?? 'The action could not be completed.',
      error?.violations ?? [],
    );
  }

  return envelope.data as T;
};

export const apiGet = <T>(path: string, signal?: AbortSignal): Promise<T> =>
  request<T>(path, signal === undefined ? {} : { signal });

export const apiPost = <T>(
  path: string,
  body: unknown = {},
  idempotencyKey?: string,
): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    body,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

export const apiPatch = <T>(path: string, body: unknown = {}): Promise<T> =>
  request<T>(path, { method: 'PATCH', body });

/**
 * Uploads a file.
 *
 * Multipart rather than JSON: a 20 MB PDF base64-encoded into a JSON string is
 * a third larger and has to be held as text at both ends. `FormData` sets its
 * own `Content-Type` boundary, which is why this does not go through `request`
 * — that function sets `content-type: application/json`, and overriding it
 * here would be the one place a header had to be wrong on purpose.
 *
 * The declared type the browser puts on the part is sent and IGNORED: the
 * server sniffs the bytes. See `uploads.ts`.
 */
export const apiUpload = async <T>(
  path: string,
  file: File,
  caption = '',
): Promise<T> => {
  const form = new FormData();
  form.append('file', file);
  if (caption.length > 0) form.append('caption', caption);

  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiRequestError(
      'network',
      'No connection to the EJE server. The file has not been attached.',
    );
  }

  const envelope = (await response.json().catch(() => ({}))) as Envelope<T>;
  if (!response.ok || envelope.error !== undefined) {
    const error = envelope.error;
    const code: ApiErrorCode = error?.code ?? 'internal_error';
    if (code === 'unauthenticated') {
      for (const listener of sessionListeners) listener();
    }
    throw new ApiRequestError(
      code,
      error?.message ?? 'The file could not be attached.',
      error?.violations ?? [],
    );
  }
  return envelope.data as T;
};

/** A fresh key per attempt at a given action, so a retry of it replays. */
export const newIdempotencyKey = (): string => crypto.randomUUID();

/** Encodes one path segment. A job number contains no slash, but an id might. */
export const segment = (value: string): string => encodeURIComponent(value);
