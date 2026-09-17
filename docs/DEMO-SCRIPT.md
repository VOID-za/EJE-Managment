# Management walkthrough — 15 minutes

Before they arrive: **Administration → System → Reset demonstration data**, then
sign out. Have the system open on the sign-in screen.

The spine of this walkthrough is a single job, **EJE-1048**, run from dispatch to
signed job card without switching records. Everything else hangs off it.

---

## 1. Why this matters (1½ min) — sign in as **Elmarie Coetzee** (Master)

Go straight to **Machines → Leadwell V-40** (`LW-V40-70214`).

Scroll to the job history and open **EJE-1044**, the service six months ago. Read
its recommendation aloud:

> "Replace the spindle drive cooling fan before the next service to avoid a drive
> over-temperature failure."

Now go back and point at today's open job on the same machine: **EJE-1048 —
spindle fault, urgent.** That prediction came true.

The point to make: *EJE already knew. The knowledge was in a technician's head
and on a paper job card nobody read again. This system keeps it against the
machine, where the next person will find it.*

## 2. The office view (2 min) — **Dashboard**

- Four tiles: open, in progress, awaiting spares, awaiting completion.
- The **overdue panel** — the system surfaces exceptions instead of waiting to be
  asked.
- **Jobs by technician** — who is loaded and who is free.
- Tap the discreet **Demo Mode** badge and show the disclosure of exactly what is
  simulated. Say plainly: *nothing in this demonstration sends an email or a
  WhatsApp message.* Close it. Trust is worth the thirty seconds.

## 3. Dispatch (1½ min) — **New Job**

ABC Engineering → Germiston → Leadwell MCV-760.

Switch the job type between **Breakdown**, **Service** and **Installation** and
let them watch the panel on the right change: the job type decides whether a
checklist and photographs are mandatory. That is configuration, not code.

Cancel — EJE-1048 is already waiting.

## 4. The technician's day (1 min) — sign out, sign in as **Sipho Mahlangu**

Let the difference land on its own: large cards, today's work first, no tables,
no menus to hunt through. Technicians may have limited computer experience.

At the top: **Waiting for you to accept — EJE-1048.**

## 5. Accepting (1 min)

Open EJE-1048. Show the **Labour & Parts** tab first: nothing can be captured
yet, because the job has not been accepted.

Back to Overview → **Accept job**. The confirmation says it plainly:

> Accepting EJE-1048 assigns it to you and moves it straight to In Progress.
> There is no separate start step — the job is live from the moment you accept it.

Accept. The job is now In Progress, the clock has started, and the audit trail
has recorded who accepted it and when.

## 6. Doing the work (4 min) — still on EJE-1048

This is the heart of the demonstration. Take it slowly.

- **Labour & Parts → Add labour.** Use the quick-pick hour buttons — a technician
  should not have to type a number. Choose **Overtime** and watch the line total
  change as the rate changes.
- **Add part** — `FAN-24V-80`, the spindle drive cooling fan, the one the last
  service recommended. Watch the job value build.
- **Add travel** — kilometres only.
- **Photos → Add photo.** Note the *Simulated* badge: the attachment is recorded
  exactly as production will, no file is uploaded.
- **Notes** — add one, and point out the internal-note toggle: internal notes
  never reach the customer's job card.
- **Completion** — write up Fault Findings, Diagnosis, Work Performed and
  Recommendations. Saving is explicit; the system warns before losing unsaved
  text.
- **Activity** — everything just done is already on the audit trail with who and
  when. Nobody typed it.

Then **Complete job**.

## 7. The customer signs (2½ min)

**Customer signature** — a screen of its own, because the tablet is handed to the
customer and nothing else should be tappable by accident.

Read the declaration aloud: *"I confirm that the work described above has been
completed."* Enter a name, sign with a finger.

**Review job card** — this is the customer's document, rendered from the live job
record, not a picture.

**Submit Job Card.** The confirmation is unambiguous:

> Once submitted, this job will be closed and the signed job card will be emailed
> to the customer.

Submit. Then:

- Open the **Simulated Outbox** and show the exact email production would have
  sent — and say again that nothing was sent.
- Reopen the job: **closed and read-only**. Nobody edits a signed job card.

## 8. Two rules worth showing (1½ min)

**The checklist gate** — open **EJE-1053**, a service job in completion. The
signature button is **disabled**, and the system says why: the mandatory checklist
has not been completed. Open the **Checklist** tab → Start checklist:

- one tap per item, large targets;
- answer **Fail** on the first item — the explanation field appears immediately,
  because a failure always needs one;
- enter an out-of-range measurement and watch it flag against the expected range.

Say clearly: *this is representative wording; production will carry the approved
EJE / WD Hearn checklists exactly.*

**Awaiting spares** — open **EJE-1051**. The reason is recorded on the job and in
the trail. A job can go in and out of Awaiting Spares as many times as the parts
situation demands.

## 9. What Masters control (1 min) — sign back in as a Master

**Administration**: users, job types and their requirements, labour rates, the
kilometre rate, VAT, checklist versions, document approval.

Change a labour rate and show a job re-pricing. Be straight about the current
limitation the dialog states: today a rate change re-prices *every* job, including
closed ones, because jobs do not yet store the rates that applied at signature.
That is the first item on the Phase 2 list.

Close on **Administration → System → Integrations** — every simulated capability
and what each becomes in production.

---

## If they ask

**"Can we find anything?"** → Search `LW-V40-70214`. Results grouped by type, each
showing which field matched — a serial number never looks like a job number.

**"Where do the manuals live?"** → Technical Library: filters, favourites,
recently viewed, current versus archived so a superseded manual cannot be
followed by accident.

**"What about the customer record?"** → Customers → ABC Engineering: three sites,
site-specific contacts, machines, full job history.

**"Does it work on a tablet?"** → It was built for one. Resize, or hand them the
tablet.

**"How long to production?"** → `docs/ARCHITECTURE.md` §6 lists exactly what
changes and what does not. The business rules, the workflow and every screen stay
as they are.
