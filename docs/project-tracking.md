# How EJE work is tracked

**GitHub is the project-status source of truth.** The separate `eje-tracker`
application and its PostgreSQL database are **retired**, and nothing in this
repository depends on them any more.

Do not build another one. No tracker database, tracker API, tracker web UI,
importer, synchronisation layer or localhost dashboard. The reason the old one
was retired is that project state kept in a second system has to be imported to
be believed, and an import that falls behind tells the business something that
is not true. GitHub already holds the commits; the work items belong beside
them.

---

## The five records, and what each one is for

| Record | What it holds | What it is NOT |
|---|---|---|
| `docs/SCOPE.md` | The requirements and the specification: every requirement ID, its wording, its amendments, the business decisions and the rules in *How this document is maintained* | Not a status dashboard, and not generated from anything |
| **GitHub Issues** | The work items. One issue per active requirement, audit finding or open business decision, titled with its ID — `[MEDIA-1] …` | Not the specification. An issue quotes the scope; it does not replace it |
| **GitHub issue comments** | Implementation and testing evidence: gate results, what was measured, what was found, what was decided | Not a place for requirements to change — those go to `docs/SCOPE.md` |
| **Git commits** | The implementation history, with the requirement ID in the subject: `feat(MEDIA-1): …` | Not a substitute for updating the scope row (PROC-1) |
| **GitHub labels** | The lifecycle status and the item's kind | Not a second opinion about what the scope says |

A requirement therefore appears in two places on purpose: its **wording** in
`docs/SCOPE.md`, its **progress** in an issue. If they ever disagree, the scope
is right about what is required and the issue is right about where the work
stands.

---

## The lifecycle

```
PLANNED → IN_PROGRESS → TESTING → APPROVED → DONE
```

plus `BLOCKED`, `SUPERSEDED` and `OPEN` (used for business decisions and for
audit findings nobody has acted on yet).

Three rules that are not negotiable, and are the reason the lifecycle has five
stages instead of two:

- **TESTED is not APPROVED.** Passing tests is the implementer's claim; approval
  is the owner's judgement.
- **PUSHED is not DEPLOYED.** A commit on a branch has changed nothing for EJE.
- **DONE requires finished *and* tested *and* owner approval.** Nothing is
  marked DONE because the code exists and the suite is green.

### Labels

| Label | Meaning |
|---|---|
| `status:PLANNED` … `status:DONE` | The lifecycle above |
| `status:BLOCKED` / `status:OPEN` / `status:SUPERSEDED` | The three states outside the line |
| `scope:…` | The scope's **own** words, preserved verbatim: `scope:NOT-IMPLEMENTED`, `scope:PARTIAL`, `scope:DEFINED`, `scope:UNVERIFIED`, `scope:TESTED-AWAITING-APPROVAL`, `scope:ACCEPTANCE-BLOCKER` |
| `requirement` / `audit-finding` / `business-decision` / `mandate` / `infrastructure` | What kind of item it is |
| `severity:HIGH` / `severity:MEDIUM` / `severity:LOW` | Audit findings only, as the scope grades them |

There are two status families because the scope's vocabulary is older and finer
than the lifecycle, and translating it away would lose information. `PARTIAL`
and `UNVERIFIED` both map onto lifecycle stages, but they do not mean the same
thing, and the issue says which word the scope used.

---

## Doing a piece of work

1. **Find the issue** for the requirement ID. No issue? Create one, titled
   `[ID] …`, before starting — an item with no ID is not recorded at all
   (PROC-3).
2. **Read the scope row** the issue links to. The row, not the issue, is the
   requirement.
3. **Check the open business decisions.** If the work needs one answered, stop
   and say so. A decision is never made by implementation (PROC-4).
4. **Implement, with the ID in the commit subject.** Update `docs/SCOPE.md` in
   the same batch (PROC-1).
5. **Record the evidence as an issue comment**: which gates ran, what they
   returned, and — where it matters — proof that a new test fails without the
   change.
6. **Move the label** to `status:TESTING` and say plainly that it awaits
   approval.
7. **Leave the issue open.** The owner closes it, or says it is approved; an
   implementer does not.

## Closing an issue

An issue is closed when the owner has approved the work and the scope row reads
**DONE** with its commit. Closing one because the tests pass is the precise
mistake this lifecycle exists to prevent.

---

## What was migrated, and from where

Migrated on 1 October 2026 under [issue #1](https://github.com/VOID-za/EJE-Managment/issues/1).
The authoritative source for every migrated issue was `docs/SCOPE.md` — not the
old tracker's database, which was itself only ever an import of this file.

Every non-DONE scope item was accounted for: active work, audit findings and
open business decisions became issues; rules (`PROC-*`), verified behaviour
(`VER-*`) and acceptance criteria (`ACC-*`) stayed in `docs/SCOPE.md`, where
they belong, because they are not work items. The complete mapping is recorded
in a comment on issue #1.

The retired repository `VOID-za/eje-tracker` may remain as an archive. The EJE
application must never depend on it, and does not.
