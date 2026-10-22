import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closedJobColumnsFor,
  closedJobPriceColumns,
  exportClosedJobs,
  exportJobList,
} from './exports';
import { emptyClosedJobFilters } from './closed-jobs';
import { emptyJobListFilters } from './job-list-filters';
import {
  describeExport,
  EXPORT_AUDIT,
  exportAuditEnabled,
  recordExport,
} from './export-audit';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import type { User, UserRole } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * TWO OPEN DECISIONS, EACH BUILT UP TO THE POINT WHERE ONLY THE DECISION IS
 * LEFT. BD-17, BD-18.
 *
 * BD-17 — MAY THE ISSUED PRICES BE EXPORTED, AND BY WHOM? Two questions, and
 * the implementation separates them: the COLUMNS exist (so "may it be exported
 * at all" is a decision EJE can see the shape of) and they are appended only
 * for `jobs.exportPrices`, WHICH NO ROLE HOLDS (so "by whom" is one line in
 * `access.ts`). Every role is asserted refused below.
 *
 * BD-18 — IS AN EXPORT RECORDED ON THE AUDIT TRAIL? The write is built and
 * switched off behind `EJE_EXPORT_AUDIT`, which is a DEPLOYMENT decision rather
 * than a boolean in the source that whoever reads the file might flip. Off, the
 * trail is untouched; on, a real event is written — and both are asserted,
 * because "the mechanism exists" is a claim about code that nobody has run.
 */
const master = seedUsers.find((user) => user.role === 'master')!;

interface Harness {
  readonly repos: RepositoryBundle;
  readonly context: OperationContext;
}

const build = (actor: User = master): Harness => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();
  return {
    repos,
    context: {
      repos,
      actor,
      services: {
        clock,
        ids,
        email: new SimulatedEmailService(outbox, clock, ids),
        whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
        pdf: new SimulatedPdfService(clock),
        storage: new DemoStorageService(inMemoryFileStore()),
      },
    },
  };
};

describe('BD-17: the issued prices', () => {
  it('are NOT in any role’s export today, which is the current behaviour', () => {
    /*
     * EVERY ROLE THE SYSTEM HAS. Listed here because `UserRole` is a type
     * union with no runtime list beside it — and the `satisfies` below is what
     * makes a role added later fail to compile until somebody decides whether
     * it may export the money.
     */
    const roles = ['master', 'coordinator', 'technician'] satisfies readonly UserRole[];

    for (const role of roles) {
      const headers = closedJobColumnsFor({ role }).map((column) => column.header);
      for (const priced of closedJobPriceColumns) {
        expect(headers, `${role} / ${priced}`).not.toContain(priced);
      }
    }
  });

  it('are not in the BYTES of a real export either', async () => {
    // Asserted against the file, not the column list: a column list that
    // drifted from the writer would pass the test above and leak the money.
    const harness = build();
    const file = await exportClosedJobs(harness.repos, master, emptyClosedJobFilters);

    expect(file.csv.length).toBeGreaterThan(0);
    for (const priced of closedJobPriceColumns) {
      expect(file.csv).not.toContain(priced);
    }
    // And the reported columns match the file, which is what the audit record
    // names.
    for (const header of file.columns) expect(file.csv).toContain(header);
  });

  it('ARE built, so answering BD-17 is a capability grant and not a feature', () => {
    /*
     * The other half of the decision. A hypothetical role holding
     * `jobs.exportPrices` gets four more columns, in a fixed order, with the
     * date the rates were frozen beside the figures — because a total with no
     * date is a figure somebody compares against this year's rates and
     * queries.
     */
    const headers = closedJobColumnsFor({ role: 'master' }).map((column) => column.header);
    expect(headers).not.toContain('Total (incl. VAT)');

    // The columns themselves, pinned so the shape of the answer is visible.
    expect(closedJobPriceColumns).toEqual([
      'Subtotal (excl. VAT)',
      'VAT',
      'Total (incl. VAT)',
      'Priced at',
    ]);
  });
});

describe('BD-18: recording an export', () => {
  const saved = process.env.EJE_EXPORT_AUDIT;

  beforeEach(() => {
    delete process.env.EJE_EXPORT_AUDIT;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.EJE_EXPORT_AUDIT;
    else process.env.EJE_EXPORT_AUDIT = saved;
  });

  const record = (harness: Harness, rowCount: number) =>
    describeExport({
      kind: 'jobs',
      actor: master,
      filters: { status: 'open', customerId: 'all', q: 'mazak' },
      rowCount,
      columns: ['Job number', 'Customer'],
      takenAt: harness.context.services.clock.now(),
    });

  it('is OFF unless the deployment says otherwise', () => {
    expect(exportAuditEnabled({})).toBe(false);
    expect(exportAuditEnabled({ EJE_EXPORT_AUDIT: 'yes' })).toBe(false);
    expect(exportAuditEnabled({ EJE_EXPORT_AUDIT: 'on' })).toBe(true);
    // The getter reads the environment at call time, so a test can change it.
    expect(EXPORT_AUDIT.recording).toBe(false);
  });

  it('writes NOTHING to the trail while it is off', async () => {
    const harness = build();
    const before = (await harness.repos.activity.list(undefined)).length;

    const outcome = await recordExport(harness.context, record(harness, 12));

    expect(outcome.written).toBe(false);
    expect(outcome.reason).toMatch(/BD-18/u);
    expect((await harness.repos.activity.list(undefined)).length).toBe(before);
  });

  it('is still off after a REAL export, asserted on the trail', async () => {
    // Through the route's own path rather than a direct call, because that is
    // where an accidental write would appear.
    const harness = build();
    const before = new Set((await harness.repos.activity.list(undefined)).map((e) => e.id));

    await exportJobList(harness.repos, master, emptyJobListFilters);
    await exportClosedJobs(harness.repos, master, emptyClosedJobFilters);

    const after = await harness.repos.activity.list(undefined);
    expect(after.filter((event) => !before.has(event.id))).toEqual([]);
  });

  it('WRITES A REAL EVENT when the deployment switches it on', async () => {
    /*
     * The half that was previously a `throw`. A server that sets
     * `EJE_EXPORT_AUDIT=on` has decided, and answering that with an exception
     * would mean the exports stop working — a worse answer than either yes or
     * no.
     */
    process.env.EJE_EXPORT_AUDIT = 'on';
    const harness = build();

    const outcome = await recordExport(harness.context, record(harness, 12));

    expect(outcome.written).toBe(true);
    const events = await harness.repos.activity.list(undefined);
    const written = events.find((event) => event.type === 'data_exported');
    expect(written).toBeDefined();
    expect(written?.summary).toMatch(/Jobs list/u);
    expect(written?.summary).toMatch(/12 row/u);
    // WHO, and in what role — the point of the record.
    expect(written?.actorId).toBe(master.id);
    expect(written?.detail).toMatch(/Master/u);
  });

  it('records the FILTERS, so "who took what" is answerable', async () => {
    process.env.EJE_EXPORT_AUDIT = 'on';
    const harness = build();

    await recordExport(harness.context, record(harness, 3));

    const events = await harness.repos.activity.list(undefined);
    const written = events.find((event) => event.type === 'data_exported')!;
    expect(written.detail).toMatch(/status=open/u);
    expect(written.detail).toMatch(/q=mazak/u);
    // `all` is not a filter, so it is left out rather than recorded as one.
    expect(written.detail).not.toMatch(/customerId=all/u);
    // Structured too, in AUDIT-2's shape, with no `from` — an export changes
    // nothing, it records what was asked for.
    expect(written.changes.map((change) => change.field).sort()).toEqual(['q', 'status']);
    expect(written.changes.every((change) => change.from === null)).toBe(true);
  });

  it('NEVER records the exported rows themselves', async () => {
    /*
     * An audit entry holding a copy of the exported data would be a second,
     * unreviewed store of the same customer information. A trail says what
     * happened; it does not keep the goods.
     */
    process.env.EJE_EXPORT_AUDIT = 'on';
    const harness = build();
    const file = await exportJobList(harness.repos, master, emptyJobListFilters);

    await recordExport(
      harness.context,
      describeExport({
        kind: 'jobs',
        actor: master,
        filters: {},
        rowCount: file.rowCount,
        columns: file.columns,
        takenAt: harness.context.services.clock.now(),
      }),
    );

    const events = await harness.repos.activity.list(undefined);
    const written = events.find((event) => event.type === 'data_exported')!;
    // A job number from the file must not be in the trail entry.
    const firstDataLine = file.csv.split('\r\n')[1] ?? '';
    const jobNumber = firstDataLine.split(',')[0]?.replace(/"/gu, '') ?? '';
    expect(jobNumber.length).toBeGreaterThan(0);
    expect(`${written.summary} ${written.detail}`).not.toContain(jobNumber);
  });
});
