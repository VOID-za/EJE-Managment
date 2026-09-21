import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NextRequest, type NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/server/auth/cookies';
import { resetRateLimits } from '@/server/api/rate-limit';
import { resetServerRuntime } from '@/server/runtime';
import { forgetDemoAccounts } from '@/server/dev/demo-switcher';
import { resetSharedDatabase } from '@/db/client';

/**
 * Drives the real API the way a browser does.
 *
 * NOT A MOCK OF THE ROUTES. It resolves the URL against the actual
 * `src/app/api` tree, imports the actual route module, and calls the actual
 * exported handler with a real `NextRequest` — so the same-origin check, the
 * session cookie, `requireAuthenticatedActor`, the validation, the idempotency
 * claim and the error shape all run. The only thing that is not real is the
 * socket.
 *
 * The cookie jar matters: the client holds whatever `Set-Cookie` the server
 * sent and nothing else. It cannot mint a session, and it never sees a user id
 * it did not receive from `/api/auth/me` — which is precisely the property the
 * tests are here to prove.
 */
const ROOT = new URL('../app/api', import.meta.url).pathname;
const ORIGIN = 'https://eje.test';

interface RouteEntry {
  /** Path segments, with dynamic ones as `[name]`. */
  readonly segments: readonly string[];
  readonly file: string;
}

const collect = (directory: string, segments: readonly string[], into: RouteEntry[]): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collect(join(directory, entry.name), [...segments, entry.name], into);
    } else if (entry.name === 'route.ts') {
      into.push({ segments, file: join(directory, entry.name) });
    }
  }
};

let routes: readonly RouteEntry[] | null = null;

const allRoutes = (): readonly RouteEntry[] => {
  if (routes === null) {
    const found: RouteEntry[] = [];
    collect(ROOT, [], found);
    routes = found;
  }
  return routes;
};

interface Match {
  readonly file: string;
  readonly params: Record<string, string>;
}

/**
 * Next's own precedence: a literal segment beats a dynamic one.
 *
 * `/api/jobs/closed` must reach the closed-jobs route rather than being read as
 * a job whose id is the word "closed".
 */
const matchRoute = (pathname: string): Match => {
  const wanted = pathname.replace(/^\/+|\/+$/gu, '').split('/');
  const candidates = allRoutes()
    .filter((route) => route.segments.length === wanted.length - 1)
    .map((route) => {
      const params: Record<string, string> = {};
      let literals = 0;
      for (const [index, segment] of route.segments.entries()) {
        const actual = wanted[index + 1] ?? '';
        if (segment.startsWith('[') && segment.endsWith(']')) {
          params[segment.slice(1, -1)] = decodeURIComponent(actual);
        } else if (segment === actual) {
          literals += 1;
        } else {
          return null;
        }
      }
      return { file: route.file, params, literals };
    })
    .filter((candidate): candidate is Match & { literals: number } => candidate !== null)
    .sort((a, b) => b.literals - a.literals);

  const best = candidates[0];
  if (best === undefined) throw new Error(`No API route matches ${pathname}.`);
  return { file: best.file, params: best.params };
};

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) =>
  | Promise<NextResponse>
  | NextResponse;

const loadHandler = async (file: string, method: string): Promise<Handler> => {
  const loaded = (await import(pathToFileURL(file).href)) as Record<string, Handler | undefined>;
  const handler = loaded[method];
  if (handler === undefined) throw new Error(`${file} exports no ${method}.`);
  return handler;
};

export interface DiscoveredRoute {
  /** A concrete URL, with any dynamic segment filled with a placeholder. */
  readonly path: string;
  readonly method: string;
}

/**
 * Every endpoint the application actually exposes, read off the route tree.
 *
 * Used to sweep the whole surface rather than a list somebody remembered to
 * update: a route added later is swept the day it is added, which is the only
 * way "every endpoint requires a session" stays true.
 */
export const discoverRoutes = async (): Promise<readonly DiscoveredRoute[]> => {
  const found: DiscoveredRoute[] = [];
  for (const route of allRoutes()) {
    const loaded = (await import(pathToFileURL(route.file).href)) as Record<string, unknown>;
    const path = `/api/${route.segments
      .map((segment) =>
        segment.startsWith('[') && segment.endsWith(']') ? 'placeholder' : segment,
      )
      .join('/')}`;
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      if (typeof loaded[method] === 'function') found.push({ path, method });
    }
  }
  return found;
};

export interface SendOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  /** Sends the request as a browser would from ANOTHER site. */
  readonly crossSite?: boolean;
  /** Drops `Sec-Fetch-Site` entirely, as an older client would. */
  readonly withoutFetchMetadata?: boolean;
  /** Overrides the cookie jar — used to prove a forged token is refused. */
  readonly token?: string | null;
}

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly data: T;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly violations: readonly { code: string; message: string }[];
  } | null;
  /** Everything the body contained, for assertions about what must NOT be there. */
  readonly raw: Record<string, unknown>;
}

export class ApiTestClient {
  private cookie: string | null = null;

  /** The token this client holds, so a test can present it after revocation. */
  get token(): string | null {
    return this.cookie;
  }

  set token(value: string | null) {
    this.cookie = value;
  }

  async send<T = unknown>(
    method: string,
    path: string,
    options: SendOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(path, ORIGIN);
    const { file, params } = matchRoute(url.pathname);

    const headers = new Headers({ host: new URL(ORIGIN).host, ...options.headers });
    if (options.withoutFetchMetadata !== true) {
      headers.set('sec-fetch-site', options.crossSite === true ? 'cross-site' : 'same-origin');
    }
    if (options.idempotencyKey !== undefined) {
      headers.set('idempotency-key', options.idempotencyKey);
    }

    const token = options.token === undefined ? this.cookie : options.token;
    if (token !== null) headers.set('cookie', `${SESSION_COOKIE}=${token}`);

    const init: { method: string; headers: Headers; body?: string } = { method, headers };
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(options.body);
    }

    const handler = await loadHandler(file, method);
    const response = await handler(new NextRequest(url, init), {
      params: Promise.resolve(params),
    });

    this.absorbCookies(response.headers);

    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      status: response.status,
      headers: response.headers,
      data: raw.data as T,
      error: (raw.error ?? null) as ApiResponse<T>['error'],
      raw,
    };
  }

  /** Keeps whatever the server set, and forgets it when the server clears it. */
  private absorbCookies(headers: Headers): void {
    for (const cookie of headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== SESSION_COOKIE) continue;
      const value = rest.join('=');
      this.cookie = value.length === 0 ? null : value;
    }
  }

  get<T = unknown>(path: string, options: SendOptions = {}) {
    return this.send<T>('GET', path, options);
  }

  post<T = unknown>(path: string, body?: unknown, options: SendOptions = {}) {
    return this.send<T>('POST', path, { ...options, body: body ?? {} });
  }

  signIn(email: string, password: string) {
    return this.post<{ user: { id: string; email: string; role: string } }>('/api/auth/login', {
      email,
      password,
    });
  }
}

/** Every seeded account shares one password; the sign-in screen says so. */
export const DEMO_PASSWORD = 'eje-demo';

export const DEMO_USERS = {
  master: 'elmarie.coetzee@eje-demo.co.za',
  secondMaster: 'johan.erasmus@eje-demo.co.za',
  coordinator: 'christene.vanniekerk@eje-demo.co.za',
  technician: 'sipho.mahlangu@eje-demo.co.za',
  otherTechnician: 'riaan.vanwyk@eje-demo.co.za',
  disabled: 'yusuf.patel@eje-demo.co.za',
} as const;

/**
 * A fresh server for one test file.
 *
 * The demonstration backend is chosen EXPLICITLY, the way a sales laptop
 * chooses it — never as a fallback. Everything else in the request path is the
 * production code.
 */
export const startTestServer = (): void => {
  process.env.EJE_PERSISTENCE = 'demo';
  delete process.env.DATABASE_URL;
  resetServerRuntime();
  resetRateLimits();
  // The new runtime has a new, empty register; the switcher must not think it
  // has already put its accounts into the previous one.
  forgetDemoAccounts();
};

/**
 * The same server, against a real PostgreSQL.
 *
 * Used by the `*.db.test.ts` suite. Nothing about the request path changes —
 * the routes, the session, the authorization and the error shape are the same
 * code — so what these tests add is the transaction boundary, the optimistic
 * concurrency and the persisted idempotency record.
 */
export const startPostgresTestServer = (url: string): void => {
  process.env.EJE_PERSISTENCE = 'postgres';
  process.env.DATABASE_URL = url;
  resetSharedDatabase();
  resetServerRuntime();
  resetRateLimits();
};

export const signedInAs = async (email: string): Promise<ApiTestClient> => {
  const client = new ApiTestClient();
  const response = await client.signIn(email, DEMO_PASSWORD);
  if (response.status !== 200) {
    throw new Error(`Could not sign in as ${email}: ${response.error?.message ?? 'unknown'}`);
  }
  return client;
};
