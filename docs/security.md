# Authentication, the HTTP API and what protects them

The browser no longer runs the business. It signs in, receives a cookie it
cannot read, and asks a server for everything — and the server decides who is
asking, what they may see and what they may do.

This document states what was built, and, where something was deliberately
deferred, says so plainly rather than leaving a gap for somebody to find.

---

## The shape of it

```
browser  ──HTTPS──▶  Next.js Route Handlers  ──▶  application operations  ──▶  repositories  ──▶  PostgreSQL
            cookie      src/app/api/**              src/application/**         src/data/postgres/**
                        src/server/**
```

| Layer | What it is responsible for |
|---|---|
| `src/app/api/**` | 41 route files. Each one names an operation; none contains business logic |
| `src/server/auth/**` | Passwords, tokens, sessions, the lockout, the cookie |
| `src/server/api/**` | The actor, the error shape, validation, idempotency, rate limiting, the read models |
| `src/server/runtime.ts` | The composition root. Which persistence, decided once, from the server's environment |
| `src/api/**` | The browser's client. Fetch and JSON, and nothing else |

**There is no path from the browser to PostgreSQL.** The client bundle contains
no driver, no connection string and no repository: every server module begins
with `import 'server-only'`, which fails the build if a client component reaches
it.

---

## Signing in

`POST /api/auth/login` takes an email address and a password.

| | |
|---|---|
| **Hashing** | Argon2id (`@node-rs/argon2`), 19 MiB memory, 2 iterations, 1 lane — OWASP's second configuration |
| **Why not bcrypt** | Argon2id is memory-hard, which is what makes a stolen hash expensive on a GPU |
| **Where the hash lives** | `users.password_hash`. `PostgresAuthStore` is the only module that reads it, and no API response carries it |
| **Unknown address** | Charged a full verification against a hash of a value nobody knows, so the timing cannot be used to ask which addresses are real |
| **Every failure** | One status, one sentence: *"That email address and password do not match."* Wrong password, unknown address, disabled account and locked account are indistinguishable |
| **Lockout** | Five consecutive failures, fifteen minutes, counted per ACCOUNT and persisted. The lock is never disclosed to the client; the office sees it on the user record |
| **Rate limit** | Twenty attempts per five minutes, counted against the client's address where a proxy header gives one — and against the email address where it does not, so one person mistyping cannot lock the whole business out of signing in |

`POST /api/auth/logout` is safe to call when already signed out — a client whose
session has just expired still holds a stale cookie, and answering with 401
would leave it in place. `GET /api/auth/me` returns the safe profile only.

---

## The session

Opaque and random, never a JWT: disabling an account has to take effect on the
next request, and a self-describing token cannot be withdrawn.

| | |
|---|---|
| **Token** | 32 bytes (256 bits) from the platform CSPRNG, base64url |
| **Stored** | The SHA-256 digest, in `sessions.token_hash`. The token itself is never written anywhere |
| **Why SHA-256 and not Argon2id** | The token is uniformly random, so there is no dictionary to slow down. What the hash buys — a database leak yields no usable session — is achieved either way, and a slow hash on every request would not be |
| **Cookie** | `__Host-eje_session`; HttpOnly, Secure, SameSite=Lax, Path=/, no Domain |
| **Idle expiry** | 12 hours, slid forward by activity (written at most once a minute) |
| **Absolute expiry** | 30 days, never extended |
| **Revocation** | On sign-out, and on disabling an account — every live session for that person, immediately |

`__Host-` is a prefix the BROWSER enforces: it stores the cookie only if it is
Secure, has no Domain and has Path=/. A sibling subdomain therefore cannot set
or overwrite EJE's session cookie. The constraint it brings is that the
application must be served over HTTPS; `localhost` counts as a secure origin, so
development and the browser suites are unaffected.

### Who the actor is

`requireAuthenticatedActor(request)` is the ONLY way a route learns who is
asking, and it runs every check in one place:

```
cookie → session exists → not revoked → not expired (idle AND absolute)
       → user exists → user is active → actor
```

**Nothing in a request body, query string or header reaches the actor.** A body
carrying `actorId` is ignored by construction, because the function never looks
at the body; the strict schemas refuse the unknown property outright.

---

## Authorization

Server-side, through the capability model that already existed
(`src/domain/access.ts`) and the existing application operations. The API does
not restate a rule — a rule stated twice is a rule that will disagree with
itself.

| Role | May manage |
|---|---|
| Master | Technicians and Coordinators. **Not** another Master: cannot edit, re-role or disable one |
| Coordinator | Technicians only. Cannot manage a Master or another Coordinator, and cannot promote a Technician to Coordinator |
| Technician | Nobody |

### Reads are actor-aware, and non-disclosing

A job this actor may not read answers **404, not 403**. Telling somebody "you
are not allowed to see EJE-1061" confirms that EJE-1061 exists, which is exactly
what the visibility rule exists to prevent.

`GET /api/search` applies the same rule before matching, so a technician cannot
discover another technician's live job by typing its number. Jobs reached
through machine history come back with prices **removed**, not hidden — there is
no unused property holding the figure.

**There is no deleted-job API.** Deletion is permanent; the audit event outlives
the job and still names it by its historical number.

---

## Cross-site request forgery

Two mechanisms, both of which must hold, and no third-party package:

1. **`SameSite=Lax` on the session cookie.** The browser does not send it on a
   cross-site POST at all, so a form on somebody else's page arrives
   unauthenticated. This alone defeats the classic attack.
2. **`assertSameOrigin` on every state-changing request.** `Sec-Fetch-Site` must
   be `same-origin` or `none`, or an `Origin` that matches the host. Chrome on
   the RugKing tablet has sent `Sec-Fetch-Site` since 2019.

**Why no synchroniser token.** It would add a token endpoint, a store, rotation
and a second thing for every client call to get right, to defend an attack that
(1) and (2) already close for every browser this application supports. The API
is same-origin with the application it serves and sends no permissive CORS
header, so there is no cross-origin credentialed request to protect. If EJE ever
needs to accept one, that decision brings the token with it.

Reads are not checked: a cross-site GET cannot change anything, and the
same-origin policy already stops the attacker reading the response.

---

## Errors

One shape, always:

```json
{ "error": { "code": "...", "message": "...", "violations": [ ... ] } }
```

| Code | Status | Meaning |
|---|---|---|
| `validation_failed` | 400 | The request was malformed |
| `unauthenticated` | 401 | No session, or it has ended |
| `forbidden` | 403 | Known actor, not entitled |
| `not_found` | 404 | No such record — or none this actor may know of |
| `conflict` | 409 | The business refused it as a clash |
| `version_conflict` | 409 | Somebody else changed it first. Never silently overwritten, never merged |
| `rate_limited` | 429 | Carries `Retry-After` |
| `workflow_refused` | 422 | Well formed, entitled, and the business says not yet. Carries the violations the screens render |
| `internal_error` | 500 | Logged on the server; the client is told nothing else |

**What never crosses this boundary:** stack traces, SQL, connection strings,
table names, password hashes, session tokens, and whether an email address
belongs to an account.

---

## Everything else the API enforces

| | |
|---|---|
| **Validation** | Zod, `.strict()` everywhere: an unknown property is refused, not ignored. Bodies, query strings and route parameters alike |
| **Body size** | 256 KiB. No file bytes cross a JSON endpoint; attachments are metadata only until object storage is built |
| **Client-set fields** | Impossible by construction. Every update loads the stored record and overlays only the editable fields, so `createdAt`, `createdBy`, `active`, `approval`, `status` and `nextJobSequence` cannot be set from a browser |
| **Idempotency** | `Idempotency-Key`, scoped to user + operation + key, with the request hash. The marker is written **in the same transaction as the change**, so a replay cannot answer for work that did not commit |
| **Transactions** | `runtime.write` opens one and builds every repository on it. A route never writes two repositories by hand |
| **Security headers** | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy`, `Permissions-Policy` |
| **Audit** | Sign-in, failed sign-in, lockout, sign-out and session revocation are on the trail, and are office-only. **No password, token or hash is ever logged** |

---

## Deliberately deferred, and why

These are gaps, stated as gaps. Nothing below is pretended to exist.

### A full Content-Security-Policy

Only `frame-ancestors 'none'` is set. A `script-src` policy strict enough to be
worth having needs a nonce threaded through Next's streaming HTML and its inline
bootstrap, plus the inline theme script that prevents a flash of the wrong
theme. Done carelessly it either breaks the application or is loose enough to be
theatre. **It is a task with a known shape, not an oversight**, and it belongs
with the deployment phase where the reverse proxy is configured.

### The rate limiter is in memory

`src/server/api/rate-limit.ts` counts in the process. **It is not distributed.**
One VPS running one Next.js process is the deployment this was built for, and
there it is exactly right. It loses its counters on restart, and two processes
would each allow the full budget.

The per-account lockout does NOT have this limitation — it is persisted, and it
is the protection that actually guards an account. The in-memory limiter guards
the SERVER from expensive work.

It also depends on the deployment giving it a client address. Behind Caddy,
`X-Forwarded-For` does; served directly, nothing does, and every request would
share one bucket — so with no address the login limit is counted per email
address instead. **Set the proxy's forwarded-for header in production**, or the
limit is per account rather than per attacker.

The interface (`consume`/`enforce`) is a function boundary, so a shared store is
a change in that file and nowhere else. **Redis is not being introduced at this
stage**, deliberately.

### Sessions are not listed or managed by their owner

There is no "sign out everywhere" screen and no list of active devices. The rows
carry the IP and user-agent to support one.

### No password reset that actually resets

`send_password_reset` records the intent on the audit trail. Delivering a reset
link needs the mail integration, which is its own phase.

### No second factor

Out of scope for this phase.

### File storage is still in process memory

An issued document's bytes live in the server process, not object storage. Said
plainly rather than disguised: a restart loses them. Object storage is its own
phase.

---

## Running against the demonstration data

The demonstration backend is **chosen, never fallen back to**:
`EJE_PERSISTENCE=demo`, or simply no `DATABASE_URL`. A deployment that has one
and cannot reach it **raises** — it does not quietly serve fabricated data,
which would be the worst outcome available here.

Every seeded account shares one password, which the sign-in screen states. There
are no real people behind the seeded names, and inventing individual passwords
would be pretending otherwise. `DemoAuthStore` is constructed only when the
demonstration backend was chosen, so it cannot become a way into a business's
data.

`POST /api/demo/reset` exists only there. On PostgreSQL `resetDemoData` is
`null` and the endpoint answers 404 — not "refused", because there is genuinely
no such capability. **A deployment holding a business's data has no code path
that can discard it.**
