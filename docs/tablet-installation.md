# Installing EJE on the technician's tablet

The field half of this system is a tablet application. It is not a native
Android build — v2.0 §26 puts that out of scope — it is the web application
installed to the home screen, which is how MANDATE-2 is delivered.

This document is the installation half of **PWA-8**. The demonstration half is
a visit to a real rugged tablet, and nothing in here claims that visit has
happened: every check below is written so that the person holding the device
can record a result against it.

---

## What has to be true of the server first

| | Why it matters |
|---|---|
| **HTTPS, on a real certificate** | A service worker will not register on plain HTTP, except on `localhost`. An install prompt will not appear either. A self-signed certificate is refused the same way |
| **One origin** | `scope` and `start_url` are both `/`. The application is served from the root of its own hostname, not from a path on a shared one |
| **A production build** | The worker registers only when `NODE_ENV === 'production'`. In development the build's chunks change on every save and a cache between them is only ever in the way |

Confirm the three before touching the tablet, because every symptom below looks
the same as a missing feature:

```
curl -I https://<host>/manifest.webmanifest     # 200, application/manifest+json
curl -I https://<host>/eje-sw.js                # 200, Cache-Control: no-store
curl -I https://<host>/icons/icon-192.png       # 200, image/png
```

---

## Installing it

1. Open **Chrome** on the tablet and sign in to the application once, so the
   session is established and the job list has been loaded at least once.
2. Chrome's menu (⋮) → **Add to Home screen** → **Install**. On a recent
   Android this reads *Install app*; on an older one, *Add to Home screen*.
3. Accept the name offered — it comes from the manifest's `short_name`, **EJE
   Job Cards** — and confirm.
4. Close Chrome entirely and launch the application from the home-screen icon.

On an iPad the steps are Safari → Share → **Add to Home Screen**. iOS does not
read the manifest's icons, which is why there is an Apple touch icon as well.

### If *Install* is not offered

It is almost always one of the server conditions above. In order of how often
it is the cause: the page is not HTTPS; the manifest 404s or is served with the
wrong content type; the 192px icon is missing or is not really a PNG; the
worker did not register. Chrome's **DevTools → Application → Manifest** panel,
with the tablet connected over USB, states which one it is — and
`npm run smoke` asserts all four against a running server before anybody walks
to the tablet.

---

## What to check on the device, and what it proves

These are the acceptance criteria that cannot be automated, in the order it is
easiest to run them. Record the result against the criterion in
`docs/SCOPE.md`; a criterion with no recorded result is not met.

| # | Do this | Pass looks like | Criterion |
|---|---|---|---|
| 1 | Install from the browser as above | The launcher shows EJE's icon and name, not a Chrome glyph with a screenshot behind it | ACC-PWA-1 |
| 2 | Launch from the home screen | No address bar, no tabs, no browser menu. The status bar matches the application's navy rather than flashing white | ACC-PWA-2 |
| 3 | Open a job → **Photos** → **Take photo** | The rear camera opens. The photograph appears as a thumbnail — the photograph itself, not a grey placeholder — and is on the job after a refresh | ACC-PWA-3 |
| 4 | **Choose photo** instead | The gallery opens and the chosen image uploads the same way | ACC-PWA-3 |
| 5 | Open a job, then kill the application from the task switcher and relaunch | The job list offers **Resume EJE-…** for the job that was open. It also says that anything not sent was not kept — which is true, and is Phase 3's boundary | ACC-PWA-4 |
| 6 | Turn flight mode on and relaunch | The job list appears with an amber notice naming the time the copy arrived. No empty list, no spinner that never ends | PWA-6 |
| 7 | Still offline, open a job from the list | It does **not** open. The list is cached; a job's own record is not. Expected, and still Phase 4's work | — |
| 7a | With a job already open, turn flight mode on and add labour, travel, a part and a note | Each is accepted and marked *held on this tablet… not on the server yet*. The job keeps showing the record it already had rather than an error page | OFF-QUEUE-1…3 |
| 7b | Still offline, kill the application and relaunch it | The offline page says how many captures are waiting and that they are not on the job | OFF-QUEUE-8 |
| 7c | Turn flight mode off and open the job | The captures send themselves, leave the queue, and appear on the job — each exactly once | OFF-QUEUE-4…5 |
| 7d | Offline, try the checklist, the write-up, a photograph or the signature | Each says it needs a connection, and says which thing it is. Nothing is accepted and dropped | OFF-QUEUE-10 |
| 8 | Deploy a new build, then reopen the application twice | A bar offers the new version and nothing reloads until it is tapped — including while a capture is open | ACC-PWA-5 |
| 9 | Sign out, then reopen the application and check with DevTools → Application → IndexedDB | `eje-job-cache` is empty: no jobs, no meta, no device pointer, no last place | PWA-6 |
| 10 | Use it one-handed, with work gloves, outside in daylight | Every control is reachable and hittable; nothing is a 20px target; the screen is legible | ACC-PWA-6 |

Check 10 is the one most likely to produce real work, and it is the one nobody
can do from a desk. Write down what was awkward rather than whether it
"passed".

---

## What the technician should be told

*Amended 17 October 2026: offline capture of four things now exists, so the
middle sentence has changed. The rest is unaltered.*

Four sentences, because anything longer will not be read:

- It installs like an app and opens like an app; sign in once and stay signed
  in.
- With no signal you can still see your job list, and the screen tells you how
  old it is.
- With no signal you can still record **hours, kilometres, parts and notes** on
  a job you are working on. They are kept on the tablet and sent the moment you
  have signal — the screen says *held on this tablet* until then, and that is
  the truth: they are not on the job yet. Nothing is lost by the battery dying.
- You **cannot** run the checklist, write the completion report, take a
  photograph or take the customer's signature without a connection. If one of
  those fails it did not happen, and the application says so rather than
  pretending.
- When a new version is ready a bar appears. Finish what you are doing, then
  tap it.

### And one thing to be clear about with the office

A held capture is **not on the job**. If a technician tells the office "the
hours are captured" while the tablet is still holding them, the office will not
see them. The job screen and the job list both show what is still waiting, and
signing out asks before leaving anything unsent.

---

## What this document does not cover

*Amended 17 October 2026.* It used to say that offline capture, the queue, sync
and conflict handling were all absent. Four append-only captures — labour,
travel, parts and notes — are now held and sent (OFF-QUEUE-1…10, scoped in
`docs/SCOPE.md` before being built). Everything else in that sentence still
stands:

- **No offline checklist, write-up, photograph or signature.** Each needs a
  connection and says so.
- **No conflict resolution policy.** If a job was signed, closed or reassigned
  while the tablet was away, the server refuses the capture, the tablet keeps it
  with the server's own words on it, and a person decides. What SHOULD happen to
  those hours is an open business decision (BD-15).
- **No background sync.** The queue is sent by the application while somebody
  is looking at it, never by a service worker with no screen to report to.

If a technician is told the tablet will "sync everything later", they have been
told something this build does not do.
