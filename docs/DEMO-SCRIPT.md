# Management walkthrough — 18 minutes

Before they arrive: **Administration → System → Reset demonstration data**, then
sign out. Have the system open on the sign-in screen.

The spine of this walkthrough is a single job, **EJE-1048**, run from dispatch to
signed job card without switching records. Everything else hangs off it.

To fit 15 minutes, drop §9 (Parts) and keep §10 short — everything in them also
answers a question in **If they ask** at the end.

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

The system then **asks** whether to send the site location:

> **Send Site Location?** — Would you like to send the site location to the
> technician via WhatsApp?

Show the message preview: job number, customer, machine, site and a navigation
link — deliberately nothing more, because every WhatsApp message costs money and
interrupts a technician who is usually already driving. Choose **Send Location**.

Worth saying out loud: the job was accepted *before* this question was asked.
Nothing is sent automatically, and if WhatsApp were down the job would still be
accepted — the message is a convenience, never a dependency.

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
  when, including whether the site location was requested. Nobody typed it.

Then **Complete job**.

## 7. The customer signs (2½ min)

**Customer signature** — a screen of its own, because the tablet is handed to the
customer and nothing else should be tappable by accident.

Read the declaration aloud: *"I confirm that the work described above has been
completed."* Enter a name, sign with a finger.

**Review job card** — this is the customer's document, rendered from the live job
record, not a picture.

**Submit for Master Review.** Say what this does and does not do: the job card
goes to the office, and the customer is *not* emailed. A technician on site never
issues a document to a customer.

Now sign out and back in as **Elmarie Coetzee** (Master). Open the job: it is in
**Master Review**, and this time it is editable. Add the part the technician
forgot to capture, and point out that it is priced at the rates frozen when the
customer signed — the office cannot accidentally re-price a signed job.

**Submit Job Card.** Now the confirmation is unambiguous:

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

## 9. Parts, and who may see the price (1½ min)

Open **EJE-1064**, a parts collection. The Parts tab carries no labour, no
travel and no call-out fee — a collection is goods over a counter, not a site
visit, so those cards are not hidden, they do not exist for this job type. Take
it through to signature: the person signing is the **collector**, and what they
confirm is that they received the parts, not that work was completed.

Then put the two seeded examples side by side:

- **EJE-1062** — customer collection. The collection note shows unit prices and
  a total.
- **EJE-1063** — courier collection. The same document is titled **Delivery
  Note** and carries no prices at all. A driver has no business seeing what the
  customer paid.

Now open EJE-1063's **Parts** tab: the prices are still there. They are withheld
from the customer-facing document, never deleted from the job — EJE still costs
the work.

## 10. What Masters control (2 min) — sign back in as a Master

**Administration**: users, job types and their requirements, labour rates, the
kilometre rate, VAT, checklists, document approval.

**Users** — active and disabled are separate lists, so a leaver does not clutter
the day-to-day one. Disable someone and show they move lists rather than
disappear: their past jobs still name them. Then find **Denise**, another
Master: there are no controls at all on that row, only the reason why. A Master
does not quietly edit a peer's account.

**Checklists** — the service checklist v1.0 shows as locked, with the reason: a
job has been completed against it, and that job card renders from this exact
version. The offer is **New version**, which copies the wording forward and
leaves the original untouched.

**Technical Library** — a technician's upload is sitting in the approval queue.
Approve it, and only then does it become official reference material.

Change a labour rate and show open work re-pricing — then open the job just
signed and show that its total has **not** moved. Every job freezes the rates it
was signed at, so a rate change can never reach a signed job card.

Then open **EJE-1044**, the service from six months ago, and show two things: its
totals are calculated at the older rates it was signed at, and its checklist is
rendered at version 1.0 while new service jobs use 2.0. History stays as it was.

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

**"Can we add a new customer or machine ourselves?"** → Customers → **Add
customer** creates the company with its first site and contact in one step; it
is immediately selectable on New Job. Machines are added from the customer's
**Machines** tab. A technician can add one too — it is usable on site
immediately but shows **Awaiting approval** until a Master confirms it onto the
register. Vaal Toolroom Services has one waiting. Try entering a serial number
that already exists: it is refused, in any casing.

**"Does it work on a tablet?"** → It was built for one. Resize, or hand them the
tablet.

**"Can we have a dark mode?"** → Tap the moon in the top bar. Light is the
default; the choice is remembered. Note that the job card preview stays white —
it represents the document the customer receives.

**"What if a technician cannot make a job?"** → On their own job, **Transfer
job**. Back to Open Jobs for whoever can take it, or straight to a named
colleague. Either way the labour, travel, parts, photos, notes and checklist
progress stay on the job — open EJE-1067 after a transfer and it is all still
there. A transfer to someone who is unavailable that day is refused.

**"How do they tell us they'll be late?"** → **Messages** → **New message**. A
technician writes to "the office" and it reaches every Master on duty, so nobody
has to guess who is at a desk. A Master replies in the same thread, so the
technician is actually answered. It says plainly on the screen that sending a
message does not mark anyone unavailable — a Master then records the period from
the message itself, and the thread shows what was recorded against it.

**"Where do system alerts go, then?"** → **Notifications**, which is a separate
place on purpose. A notification is the system telling you something happened; a
message is a person asking you something. Each notification opens where it
belongs: a submitted job card opens the job in Master Review, a message opens
its conversation. Nothing is funnelled to one screen.

**"Can we stop someone being booked when they're out?"** → Yes, and not just
on the calendar. Mark a technician unavailable from their profile, then try to
assign them to a job that day: it is refused, with the window and the reason.
Recording an absence over work already booked never moves those jobs — it
lists them for you to deal with.

**"What if a job was raised by mistake?"** → Two different actions, and the
difference matters. **Delete** for a job that should never have existed —
EJE-1065 is a duplicate. **Cancel** for a real job that will not happen, like
EJE-1066, with a required reason. Neither destroys anything: both keep the
record and the audit trail, both leave the active lists and the calendar, and
both stay findable in search, labelled so they can never read as live work.
Once a technician has accepted a job, Delete is no longer offered at all.

**"Where do closed jobs go?"** → **Closed Jobs** in the sidebar, or the *Closed
Jobs* link on the Jobs screen. Every issued job card, searchable by job number,
customer, site, machine, serial number, order number or reference, and
filterable by customer, site, job type, technician and the date it was closed.
Open EJE-1044: the complete record as it was issued, read-only, with the final
signed document on file — file name, page count, who issued it and the address
it went to. **View Final PDF** shows that document; **Download Final PDF** saves
it under the same name every time. Then change the charge-out rate on
Administration → Rates & VAT and come back: the total has not moved, because the
rates were frozen onto the job at signature. The same applies to the checklist:
EJE-1044 still renders version 1.0-DEMO while new service jobs use 2.0-DEMO.

**"Is it the same record as in the customer's history?"** → Yes, one record. Open
EJE-1044 from Closed Jobs, from ABC Engineering → Job History, or from the
machine's own page: all three land on the same job. There is no second archived
copy that could drift out of step.

**"How long to production?"** → `docs/ARCHITECTURE.md` §6 lists exactly what
changes and what does not. The business rules, the workflow and every screen stay
as they are.
