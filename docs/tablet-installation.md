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
| 5 | Open a job, type into the write-up, then kill the application from the task switcher and relaunch | The job list offers **Resume EJE-…** for the job that was open, and the write-up text is still there (kept as a local draft, WRITEUP-4) — *amended 26 October 2026: this row said nothing unsent was kept, which stopped being true* | ACC-PWA-4 |
| 6 | Turn flight mode on and relaunch | The job list appears with an amber notice naming the time the copy arrived. No empty list, no spinner that never ends | PWA-6 |
| 7 | Still offline, open a job that was open earlier | Its detail opens from this tablet's copy, saying how old the copy is and that it cannot be changed from there (OFF-DETAIL-1). A job never opened on this tablet does not open — expected — *amended 26 October 2026* | OFF-DETAIL-1 |
| 7a | With a job already open, turn flight mode on and add labour, travel, a part and a note | Each is accepted and marked *held on this tablet… not on the server yet*. The job keeps showing the record it already had rather than an error page | OFF-QUEUE-1…3 |
| 7b | Still offline, kill the application and relaunch it | The offline page says how many captures are waiting and that they are not on the job | OFF-QUEUE-8 |
| 7c | Turn flight mode off and open the job | The captures send themselves, leave the queue, and appear on the job — each exactly once | OFF-QUEUE-4…5 |
| 7d | Offline, answer a checklist item, type the write-up, take a photograph, then try to take the signature | The answer, the write-up draft and the photograph are each held and marked *on this tablet*; **the signature and a refusal say they need a connection** (open decision BD-23). Nothing is accepted and dropped — *amended 26 October 2026* | OFF-CHK-1, OFF-WRITEUP-1, OFF-MEDIA-1, OFF-QUEUE-10 |
| 8 | Deploy a new build, then reopen the application twice | A bar offers the new version and nothing reloads until it is tapped — including while a capture is open | ACC-PWA-5 |
| 9 | Sign out, then reopen the application and check with DevTools → Application → IndexedDB | `eje-job-cache` is empty: no jobs, no meta, no device pointer, no last place | PWA-6 |
| 10 | Use it one-handed, with work gloves, outside in daylight | Every control is reachable and hittable; nothing is a 20px target; the screen is legible | ACC-PWA-6 |

### The rest of the checklist — October mandate, Workstream D

*Added 21 October 2026.* Checks 1–10 covered installation, the camera, offline
capture and reconnect. The mandate asks for the rest of what only a device can
answer, so these are checks 11–18. **Each one has a failure mode that a
headless browser cannot see**, which is the test for whether it belongs here.

| # | Do this | Pass looks like | Why a desk cannot answer it |
|---|---|---|---|
| 11 | **Refuse the camera.** First photograph on a fresh install: tap *Take photo* and press **Block** on Chrome's prompt | The application says the camera was not allowed and how to allow it. It does not sit on a spinner, and *Choose photo* still works | The prompt is Chrome's and appears once per origin per device |
| 12 | **Allow it afterwards.** Chrome → site settings → Camera → Allow, return to the job | *Take photo* works without reinstalling or signing in again | Permission state lives in Chrome, not the app |
| 13 | **Upload on a bad connection.** Take a photograph with one bar of signal | Progress is visible while it sends. If it fails, it says so and offers to retry THAT photograph — it does not silently drop it or appear to succeed | A throttled desk connection is not a bad mobile one |
| 14 | **Sign with a finger, then a stylus, in both orientations.** Rotate the tablet mid-signature | The stroke follows the finger with no visible lag; the pad does not clear on rotation; the captured signature looks like the one that was drawn | Touch latency, palm rejection and the rotation event are device behaviour |
| 15 | **The on-screen keyboard.** Open the completion write-up, tap into *Work performed*, type a long paragraph, scroll, then dismiss the keyboard | Nothing typed is lost. The field stays visible above the keyboard rather than behind it, and the page does not scroll away from the caret | The keyboard's height and the viewport resize differ by device and by keyboard app |
| 16 | **A long form in portrait.** Complete a checklist of 20+ items, plus labour, travel and three parts, in portrait | Every control stays reachable, the save buttons do not end up under the keyboard, and nothing already entered scrolls out of reach | Portrait on a 10" rugged tablet is not 390×844 |
| 17 | **Session expiry.** Leave the application open and untouched overnight, then tap something that writes | It says the session ended and asks for a sign-in; **anything unsent is still there afterwards**. It does not fail silently or discard the capture | Only real elapsed time expires a real session |
| 18 | **Unsent work and a sign-out.** With captures held offline, sign out deliberately | It says what is unsent and whose it is, and does not discard it. After signing back in as the SAME technician it is still there; as a different one it is not offered | The warning and the per-owner store are only interesting on a shared device |

### A full job, and recovery — 26 October 2026

*Added for the completion mandate.* These are the checks that close the offline
mandate on the device. **19–22 can be run now. 23 depends on open decision BD-23**
(offline signature and refusal): until EJE decide it, a signature needs signal by
design, and check 23 is recorded as BLOCKED rather than failed.

| # | Do this | Pass looks like | Criterion |
|---|---|---|---|
| 19 | **A full job with the network off, up to the signature.** Accept a job in signal, open it, then flight mode on: add labour, travel, a part and a note; answer the whole checklist including a failed item with its note; take two photographs; write the completion report | Every capture is held and marked *on this tablet*; nothing is refused that the job allows; the write-up survives scrolling and the keyboard | ACC-OFF-2, ACC-OFF-3, ACC-OFF-4 |
| 20 | **Lock it, close it, flatten it.** Mid-way through 19: lock the screen for ten minutes; kill the application; then let the battery run to shutdown, charge and power on | After each, everything captured so far is still held, named and counted on the offline page; the write-up draft is word for word | ACC-OFF-6, ACC-PWA-4 |
| 21 | **Reconnect.** Flight mode off with everything from 19 held | Captures send oldest first, each row says *Sending…* and leaves when the server has it; photographs upload; the write-up saves; nothing appears twice on the job (check the Activity trail) | ACC-OFF-7, ACC-OFF-8, ACC-OFF-10 |
| 22 | **A conflict.** Hold a capture offline; meanwhile have the office cancel or reassign the job; reconnect | The capture is not applied, the technician is told in the server's words, and it appears on the office's *Field Captures* to decide — never silently dropped or overwritten | ACC-OFF-9, ACC-OFF-11 |
| 23 | **The signature and the refusal, offline.** Continue 19 to the signature step with the network still off | **BLOCKED on BD-23.** Today: it says it needs a connection. Once BD-23 is decided and built: re-run 19–22 through to signature, reconnect, and confirm the job submits exactly once | ACC-OFF-5, ACC-OFF-12 |

### The acceptance record

Fill one row per check, on the device EJE will issue to technicians. **Every row
reads UNVERIFIED until somebody has done it on that device**; nothing here may be
filled from a headless browser, an emulator or a desktop.

| Field | Value |
|---|---|
| Device make and model | *e.g. Samsung Galaxy Tab Active5 — EJE to confirm the model* |
| Android version, Chrome version | |
| Deployment URL and release SHA under test | |
| Tester, date, time of day, weather (daylight checks) | |

| Check | Result (PASS / FAIL / BLOCKED / UNVERIFIED) | Evidence (photo, screen recording, or what was seen) | Notes |
|---|---|---|---|
| 1–4 install, icon, standalone, camera | UNVERIFIED | | |
| 5–9 resume, offline list and detail, held captures, update | UNVERIFIED | | |
| 10 gloved, one-handed, daylight | UNVERIFIED | | |
| 11–18 camera permission, bad signal, signing, keyboard, long form, expiry, shared tablet | UNVERIFIED | | |
| 19–22 full offline job, recovery, reconnect, conflict | UNVERIFIED | | |
| 23 offline signature / refusal | BLOCKED — BD-23 | | |

**Record a result against every one.** A row with no result is not a pass, and
checks 11, 13, 15 and 17 are the four most likely to find something: each
depends on behaviour that belongs to Chrome, to the radio, to the keyboard app
or to the clock rather than to this application.

Checks 10 and 14 are the ones most likely to produce real work, and they are
the ones nobody can do from a desk. Write down what was awkward rather than
whether it "passed".

**WHAT IS NOW MEASURED FROM A DESK, AND WHY IT DOES NOT REPLACE CHECK 10.**
*Added 18 October 2026.* `npm run responsive-check` measures every screen at
1024×768, 820×1180 and 390×844 and fails on sideways scroll, on a control whose
box ends past the right edge, on a tap target under 36px, on a control that
cannot be focused, and on any of those appearing once a 200-character fault
description and a long customer name are typed in. It runs in CI. It found five
real defects — a closed navigation drawer that was still focusable, 16px
breadcrumb links, a 58×16px job-number link on the activity trail and the
dashboard, 24px chips on the search screen, and the calendar's "+N more" sitting
below the bars beside it — and all five are fixed.

None of that is check 10. A headless browser cannot tell you that the screen
washes out in Highveld sun at two in the afternoon, that a gloved thumb covers
three controls at once, or that the stylus skips on a cracked screen protector.
What the audit buys is that the person doing check 10 is reporting on the things
only a person can report on, instead of finding a button off the edge of the
screen.

**Check 8 is now stronger than it was.** The update bar does not merely refrain
from reloading mid-capture — it does not APPEAR mid-capture. It is `sticky` at
the top of the page, so appearing used to push the signature pad down under
whatever was drawing on it. While a signature, a write-up with unsaved text or a
photograph being sent is on screen, the bar renders nothing at all and appears
once the capture is finished.

---

## What the technician should be told

*Amended 17 October 2026: offline capture of four things now exists, so the
middle sentence has changed. Amended again 18 October 2026: the checklist can
be answered and the write-up typed with no signal, a refused capture goes to
the office, and signing out with no signal is now honest about what it could
not do.*

Four sentences, because anything longer will not be read:

- It installs like an app and opens like an app; sign in once and stay signed
  in.
- With no signal you can still see your job list, and the screen tells you how
  old it is.
- With no signal you can still record **hours, kilometres, parts and notes** on
  a job you are working on. They are kept on the tablet and sent the moment you
  have signal — the screen says *held on this tablet* until then, and that is
  the truth: they are not on the job yet. Nothing is lost by the battery dying.
- With no signal you can also **answer the checklist** — one item at a time,
  tapping *Hold answer* — and **type the completion write-up**, which is kept
  as a draft on the tablet. A held answer is not on the job and is not counted
  in the percentage; the draft is not on the job either, and you put it there
  yourself when you have signal.
- With no signal you can **photograph** the work, the evidence a checklist
  question asks for, and the machine you are on. The photographs are kept on
  this tablet — the screen says *Not sent* and counts them — and go up when
  there is a signal. The tablet will hold up to 25 of them; past that it says
  so plainly rather than quietly dropping one.
- And the job you had open stays **readable** with no signal: the hours, parts,
  notes and the checklist questions still outstanding. It is marked as a copy,
  with the time it came from, and nothing on it can be changed from there.
- You **cannot** complete the checklist or take the customer's signature
  without a connection. If one of those fails it did not happen, and the
  application says so rather than pretending.
- If the job was signed, closed or given to somebody else while you were out of
  signal, the server will not take your capture — and it is **not lost**. It
  goes to the office, who decide what happens to it, and the tablet tells you
  it is with them. You do not have to do anything else about it.
- When a new version is ready a bar appears. Finish what you are doing, then
  tap it.

### And one thing to be clear about with the office

A held capture is **not on the job**. If a technician tells the office "the
hours are captured" while the tablet is still holding them, the office will not
see them. The job screen and the job list both show what is still waiting, and
signing out asks before leaving anything unsent.

The office has one new screen for this: **Field Captures**, for Masters and
Coordinators. Work a tablet could not get onto a job appears there with the
technician's name, the job, and the server's own reason for refusing it, and
somebody decides — either applying it to the job, which goes through exactly
the same rules as a line typed at a desk, or recording that nothing further
will happen and why. Nothing on that screen edits the technician's capture, and
nothing resolves itself.

## The shared tablet: what is kept on the device, and what that means

*Added 18 October 2026, with BD-16. Read this before a tablet is shared between
shifts, because it is the part a device policy has to cover.*

- **Unsent work stays on the tablet, under the name of whoever captured it.**
  Hours, kilometres, parts, notes, held checklist answers, a write-up draft and
  held photographs are the only record of work the server has not seen, so
  signing out does not destroy them. They are keyed to their owner: the next person to sign in does
  not see them, cannot send them, cannot retry them and cannot discard them.
  They are sent when their owner signs in again, with a connection.
- **The read cache is not kept.** The cached job list, the cached detail of a
  job that was open, who the device last saw signed in and which job it was are
  all cleared on sign-out, and again when the next person signs in. Those are
  copies of what the server has; losing them costs nothing. The cached copy
  holds no prices, no signature, no document and no customer contact details in
  the first place.
- **No password, session cookie or access token is ever written to the device
  by this application.** The session is a cookie the page itself cannot read.
- **This is not encryption, and the application does not claim it is.** Unsent
  work is held in the browser's ordinary storage. Somebody with the tablet
  unlocked and a browser console could read it. The protection the application
  gives is that nobody can reach another person's work *through the
  application*; the protection for the device itself is the tablet's own screen
  lock, EJE's device policy, and not leaving an unlocked tablet with a customer.
- **Signing out with no signal cannot end the session on the server**, because
  the message cannot be sent. The tablet now refuses to use that session
  afterwards and finishes the sign-out as soon as it has a connection — and the
  sign-in screen says so while it is waiting. Before this it signed the
  previous technician straight back in on the next page load, so a tablet
  handed over in a yard with no coverage carried their identity. **If a tablet
  is lost, the office must still disable the account** — that is what revokes
  the session, not anything the device can do.

---

## What this document does not cover

*Amended 17 October 2026.* It used to say that offline capture, the queue, sync
and conflict handling were all absent. Four append-only captures — labour,
travel, parts and notes — are now held and sent (OFF-QUEUE-1…10, scoped in
`docs/SCOPE.md` before being built). Everything else in that sentence still
stands:

- **No offline signature**, and the checklist cannot be COMPLETED offline.
  Each needs a connection and says so. *(Amended 18 October 2026: answering the
  checklist, typing the write-up as a draft and taking photographs are now all
  possible — OFF-CHK-1, OFF-WRITEUP-1, OFF-MEDIA-1 — and the job you had open
  is readable from this tablet's own copy, OFF-DETAIL-1.)*
- ~~**No conflict resolution policy.**~~ *Answered 18 October 2026 by BD-15.*
  If a job was signed, closed or reassigned while the tablet was away, the
  server refuses the capture, the capture is retained with the server's own
  words on it and referred to the OFFICE, and a Master or Coordinator decides
  on the Field Captures screen. Nothing retries by itself, and nothing resolves
  itself.
- **No background sync.** The queue is sent by the application while somebody
  is looking at it, never by a service worker with no screen to report to.

If a technician is told the tablet will "sync everything later", they have been
told something this build does not do.
