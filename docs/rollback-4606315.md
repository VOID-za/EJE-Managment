# Rollback and recovery — release 4606315 (migration 0047)

Written 3 November 2026. **Analysis and procedure only — nothing here was executed.**
No rollback, restore, destructive migration or production database change was made.

## 1. The position

| | |
|---|---|
| Live release | `9569c85` since 3 November 2026 07:59:28 UTC (healthy 07:59:30): `4606315` plus the unsigned job card's documents (UNSIGNED-ATT-1). No migration. `4606315` itself was released 2 November 2026 20:47:23 UTC (healthy 20:47:26) |
| Migration it added | `0047_batch_2_november` — additive only (new enum values, columns with defaults, new tables, guard triggers) |
| Recorded rollback target | **`4606315`** (the release before `9569c85`). It is the same schema and every 0047 feature; rolling back to it loses only the unsigned copy's documents (it sends the PDF alone). **`b3a9014`** is the last release from BEFORE 0047, built and kept on the server (`/opt/eje/releases/b3a9014/.next` present, read-only check 3 November). This document is about going back to it |
| Backup before 0047 | `/var/backups/eje/eje-eje_production-2026-11-02T20-47-09Z` (verified, key-checked, restore-tested by the guarded release). Newest release backup: `/var/backups/eje/eje-eje_production-2026-11-03T07-59-16Z` (before `9569c85`, at 0047) |
| Down migrations | **None exist, and none should be written.** 0047 is not reversed by switching code |

`b3a9014` is **database-compatible** with 0047: it starts, its preflight accepts 48 applied
migrations against the 47 it ships, and it reads and writes every table it knows. It is
**not feature-compatible**: it has never heard of what 0047 stores, so it ignores or hides it.

## 2. Which earlier application versions can run against 0047

| Version | Ships up to | Against a database at 0047 |
|---|---|---|
| `4606315` | 0047 | **Fully supported**: the release that added 0047. The first choice if `9569c85` must be undone (`stage-release.ps1 -Rollback`, which picks the recorded target). |
| `b3a9014` | 0046 | **Supported.** Proven in CI by `scripts/release/rollback-compat.sh` (the live release's own code against a disposable database migrated to 0047). Since 3 November the probe also writes every kind of 0047 row and records what `b3a9014` makes of each (§3). |
| `6fdb142` and older (`5d726d3`, `7c0ca94`, …) | 0045 or less | **Not supported.** Each was proven only against its successor's migration. They do not know 0046 either (the PO number, the *Awaiting Invoice No* status, replaceable submissions), so a job in a status they do not know would be mishandled. Never roll back past `b3a9014`. |

## 3. What `b3a9014` would do with data written by the new features

Verified two ways: reading `b3a9014`'s own code (`git show b3a9014:…`), and the CI rollback
probe, whose `0047` case runs `b3a9014`'s repositories against these rows
(`scripts/release/rollback-probe.db.test.ts`, "meets the 0047 rows without error or damage").

| 0047 data | Under `b3a9014` | Damaged? | Risk while rolled back |
|---|---|---|---|
| **Apprentice users** (`users.role = 'apprentice'`) | Read without error. `capabilitiesFor` falls back to **no capabilities** for a role it does not know, and the role has no label. | No — the row is untouched. | **Apprentices are locked out**: they can sign in but can do nothing; jobs assigned to them must be handled by others. They cannot be edited in Admin → Users (the old form does not offer the role). |
| **Customer rate option and Custom Rates** (`customers.rate_mode`, `customer_rates`) | Ignored. Saving a customer keeps both (the old save does not write those columns). | Not the rows. | **Unsafe for pricing.** A job for a Custom Rates customer is priced at the DEFAULT rates, and if it is signed under `b3a9014` the default price is frozen into its snapshot. Signed prices are never repriced, so **that job's price stays wrong after rolling forward**. |
| **Already-signed snapshots** (any customer) | Read as stored; never repriced. | No. | None. |
| **Documents chosen for the customer email** (`job_media.email_to_customer`) | Ignored; saving the job keeps the choice (the old upsert does not write the column). | No. | A signed job card email written by `b3a9014` carries the PDF only. |
| **Emails with extra attachments** (`email_messages.extra_attachments`) | The row is read; the extra attachments are **not part of what the old code sends**. | Not the row. | **A queued email would be sent WITHOUT its selected documents**, which is a silent omission. Today email is in `refuse` mode on the testing site, so nothing is sent; on a site that sends email, see step 2(e). |
| **Approved day swaps** (`standby_day_overrides`) | Ignored. The calendar shows the **weekly** holder on a swapped day. | No — overrides cannot be changed or deleted (guard trigger). | **The wrong person is shown on standby** for every swapped day. |
| **Pending day swaps** (`standby_day_swaps` awaiting the recipient or the Office) | Invisible; nothing can answer, decide or withdraw them. | No. | They wait, untouched, until rolling forward. |
| **Day-swap notifications** (4 new types) | Read, but sorted into **none** of the old inbox tabs. | No. | They are hidden. |
| **Jobs cancelled at In Progress / Awaiting Spares / Completion** (with a reason) | Read normally: *Cancelled* is a status it knows. | No. | None. Only the office can cancel again under its rule. |
| **Apprentice standby places** | Readable (the database allows a technician or apprentice). The old assignment list offers technicians only. | No. | An apprentice place cannot be changed to another apprentice. |
| **Unsigned job card with chosen documents** (this follow-up, if released) | `b3a9014` sends the PDF only, with no document checks. | No. | The chosen documents are not sent. |

**Nothing written by 4606315 is damaged by `b3a9014`.** The database's 0047 guards stay in
force (overrides, day swaps and extra attachments cannot be rewritten). What is lost while rolled
back is **meaning**: who is on standby, apprentices' access, Custom Rates pricing, and emailed
documents. One effect is permanent: a Custom Rates job signed under `b3a9014` keeps its default price.

## 4. Forward-fix first

**A forward-fix is safer than rolling the application back** for any defect confined to a feature:

- it keeps every 0047 feature working, with no window of wrong standby display, locked-out apprentices or mispriced signatures;
- it goes through the same guarded release (CI green, a proven backup, health gate, automatic switch back on a failed health check);
- 0047 stays applied either way, so a rollback does not undo any database change.

**Roll the application back only when** 4606315 is broadly unusable (unhealthy, failing to serve,
corrupting writes) **and** a forward-fix cannot be released in time. Restore a backup only for lost
or corrupted data (§6), never as a way to roll back.

## 5. The application rollback, step by step (if it must happen)

1. **Decide and record it.** Name the reason, the person deciding, and the time. Tell the owner.
2. **Read-only snapshot of what will be ignored** (on the server, as a reader; nothing is written):
   a. active apprentices — `select id, first_name, last_name from users where role = 'apprentice' and active;`
   b. Custom Rates customers and their unsigned jobs — `select id, name from customers where rate_mode = 'custom';` plus the jobs of those customers not yet signed. **Tell the office not to take signatures on them until rolled forward.**
   c. approved day changes from today on — `select date, position, user_id from standby_day_overrides where date >= current_date order by date;` **Send this list to everyone on standby**, because the calendar will show the weekly holders.
   d. pending day swaps — `select id, status from standby_day_swaps where status in ('awaiting_recipient','awaiting_office');`
   e. emails that would lose documents — `select id, state from email_messages where state in ('queued','sending','attention') and extra_attachments <> '[]'::jsonb;`. If any exist and the site sends email, **set email delivery to `refuse` before switching**, or resolve them first.
   f. the usual before snapshot (job-card fingerprints, counts, signed prices, attendance, timesheets, site pins), as for a release.
3. **Switch the application, not the database.** If `9569c85` alone is the problem, `stage-release.ps1 -Rollback` (no `-To`) returns to `4606315`, and none of the steps in 2 apply. Going back past 0047:
   `powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Rollback -To b3a9014 -SshExe C:\Windows\System32\OpenSSH\ssh.exe -LogDir <dir>`
   This runs `deploy-release.sh --rollback b3a9014`. It relinks `/opt/eje/app`, restarts the service and waits for `/api/health` to report `b3a9014` with the database reachable. **It does not touch the database.** Its message still says "Migration 0030 stays applied": that wording is out of date, and the meaning (the database is left as it is) is correct.
4. **Verify:** health reports `b3a9014`, `deployment: demonstration`, the email mode is as intended; the after snapshot matches the before snapshot; a signed job card opens.
5. **While rolled back:** no signatures on Custom Rates customers' jobs; standby follows the list from 2(c); apprentices' work is covered by others.
6. **Roll forward** as soon as possible by releasing 4606315 (or its fix) through `stage-release.ps1`. The preflight finds **no pending migration**, because 0047 is still applied, and every 0047 row reappears as it was. Then review anything `b3a9014` wrote in the window, especially any job signed for a Custom Rates customer. Its price cannot be changed; record it and tell the owner.

## 6. Backups and restoring

- **Before every release** the guarded process takes a backup, verifies it, checks the key and runs a restore test. The 0047 release did this: `/var/backups/eje/eje-eje_production-2026-11-02T20-47-09Z`. The nightly backup and weekly restore test continue (`docs/vps-backups.md` §3–4).
- **Before any rollback**, take and prove a fresh backup the same way (`npm run backup`, `backup:verify`, `backup:key-check`, `backup:restore-test`). A rollback does not need it, but the next decision might.
- **Restoring is done only as described in `docs/vps-backups.md` §6:** stop the service; verify the backup; restore into a NEW database (`eje_production_restored`) and the documents beside the live ones; inspect counts and `documents:reconcile`; only then swap, keeping what was replaced. **Never restore over `eje_production` or `/var/lib/eje/storage` in one step.**

**Restoring the pre-0047 backup has these consequences:**

- **Every change made since 20:47:09 UTC on 2 November 2026 is lost**: jobs, signatures, attendance, timesheets, submissions, messages and audit entries, as well as all 0047 data (apprentices, Custom Rates, chosen documents, day swaps). Documents uploaded since then would have no database row.
- The restored database is at **0046**, so only `b3a9014` can run on it. 4606315 cannot run on it until a guarded release applies 0047 again.
- **Use it only for corruption or destructive loss that a forward-fix cannot repair**, and only after the owner has decided. It is never the way to "undo" a release.

## 7. Limits of this analysis

- The 0047 rows in the CI probe are representative, one of each kind, not a copy of live data. **The live site is in use**: on 2 November it held none of them; on the morning of 3 November it held 8 customers, **1 of them on Custom Rates** (read-only snapshot before `9569c85`). Its unsigned jobs are exactly the case §3 marks unsafe, so a rollback to `b3a9014` now needs step 2(b).
- Screens were not exercised under `b3a9014` against 0047 data. The probe covers repositories and domain rules; the screen effects above come from reading `b3a9014`'s code.
- Releases older than `b3a9014` were not tested against 0047 and are not supported.

## 8. Migration 0048 — the physical acceptance follow-up (3 November 2026)

**What 0048 adds (additive only):** `jobs.delivery_date`, `job_parts.comment`, the `delivery_note` job type row and its guards (no price, labour, call-out or invoicing status on a Delivery Note); `timesheet_periods.superseded_at` / `superseded_by` and the guard allowing one current submission per person per day; the standby guards widened to a Senior Tech in main and helper places. Nothing existing is rewritten.

**The rollback target after this release is `9569c85`** (the release before it, at 0047). The CI rollback check now runs `9569c85`'s own code against a database at 0048 that holds a Delivery Note, a superseded timesheet and a Senior Tech on standby. It proves the old code still starts, reads and writes. It also records what that code makes of the new rows:

| 0048 data | Under `9569c85` | Risk while rolled back |
|---|---|---|
| **Delivery Note jobs** | The row is read, but `9569c85` has no `delivery_note` job type: every screen that looks the type up (job lists, the job page, Closed Jobs) fails for that job. Re-saving an **unsigned** Delivery Note drops its part comments, because the old code rewrites part lines without them. | **Unsafe once any Delivery Note exists.** A signed one is protected by the signed-job triggers; an unsigned one can lose comments. |
| **Superseded timesheet submissions** | Listed as sent again: the office sees both the earlier and the later submission for the same days, and a technician's new overlapping period is refused by the old rule. | Confusing, not damaging. Nothing is deleted. |
| **A Senior Tech in a standby place** | Shown, but the old rules treat the Senior Tech as ineligible: the week is flagged, and the old screen will not offer the Senior Tech. | Office confusion. The place stays. |
| **Day swaps between the main/helper rotation pair** | Approved swaps stay in place. New such swaps are refused again (the old defect). | The defect returns until rolled forward. |

**Recommendation: forward-fix only once a Delivery Note exists.** If an application rollback is unavoidable, run the steps in §5 with `-Rollback` (the recorded target is `9569c85`). First list the Delivery Notes with `select job_number, status from jobs where job_type_code = 'delivery_note';` and tell the office not to open or edit them until the system is rolled forward. A database restore follows §6 and loses everything since the pre-0048 backup.
