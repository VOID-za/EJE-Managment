# Suggested demonstration order

About 15 minutes. Reset first via **Administration → System → Reset
demonstration data**.

## 1. The office view (2 min) — sign in as **Elmarie Coetzee** (Master)

Land on the dashboard. Point out:

- the four tiles: open, in progress, awaiting spares, awaiting completion;
- the **overdue** panel — the system surfaces exceptions rather than waiting to
  be asked;
- jobs by priority and by technician, so workload is visible at a glance;
- the discreet **Demo Mode** badge — tap it to show exactly what is simulated.

## 2. Raising a job (2 min)

**New Job.** Choose ABC Engineering → Germiston → the Leadwell MCV-760. Change
the job type between Breakdown, Service and Installation and point out the panel
on the right updating: the job type decides whether a checklist and photographs
are mandatory. Create the job, or cancel — either is fine.

## 3. The technician view (1 min) — sign out, sign in as **Sipho Mahlangu**

Note how different it is: large cards, today's work first, no tables. Point out
that jobs awaiting acceptance are called out at the top.

## 4. Working a job (4 min) — open **EJE-1048**

Urgent breakdown, already in progress.

- **Labour & Parts** → Add labour. Use the quick-pick hour buttons — technicians
  should not have to type. The line total is priced as you choose the rate type.
- Add a part; note the running job value.
- **Completion** → write up what was done. Save is explicit.
- **Photos** → attach a photo (marked *simulated*, nothing is uploaded).
- **Activity** → every action just taken is already on the audit trail, with who
  and when.

Then **Complete job** → **Customer signature**.

## 5. The checklist gate (2 min) — open **EJE-1053**

A service job in completion. The signature button is **disabled**, and the system
says why: the mandatory checklist has not been completed.

Open the **Checklist** tab → Start checklist. Show:

- one tap per item, large targets;
- answering **Fail** immediately asks for an explanation;
- a measurement outside the expected range is flagged against that range;
- progress and outstanding items always visible.

Mention that this is representative wording, and that production will carry the
approved EJE / WD Hearn checklists exactly.

## 6. Signature and hand-over (3 min) — back on **EJE-1048**

- The signature screen is a screen of its own — the tablet is handed to the
  customer. Read the declaration aloud.
- Enter a name and sign with a finger.
- **Review job card** — this is the customer's document, rendered from the live
  job record.
- **Submit Job Card** → the confirmation says the job will be closed and the
  signed card emailed to the customer.
- Submit. Then open the **Simulated Outbox** and show the exact email that
  production would have sent — and that nothing was sent.
- Reopen the job: it is now closed and read-only.

## 7. The records behind it (2 min)

- **Customers → ABC Engineering** — sites, site-specific contacts, machines, full
  job history.
- **Machines → Leadwell V-40** — serial number, installation date, service
  history. Note EJE-1044 recommended replacing the spindle drive fan: the
  breakdown just worked was the predicted failure.
- **Search** `LW-V40-70214` — results grouped by type, each showing what matched.
- **Technical Library** — filters, favourites, recently viewed, current versus
  archived versions.

## 8. What Masters control (1 min) — sign back in as a Master

**Administration**: users, job types and their requirements, labour rates, the
kilometre rate, VAT, checklist versions and document approval. Change a labour
rate to show open jobs re-pricing.

Close on **Administration → System → Integrations**: every simulated capability,
and what each becomes in production.
