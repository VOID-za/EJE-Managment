import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closedJobColumnsFor,
  closedJobPriceColumns,
  exportClosedJobs,
  exportJobList,
} from './exports';
import { emptyClosedJobFilters } from './closed-jobs';
import { emptyJobListFilters } from './job-list-filters';
import { describeExport, recordExport } from './export-audit';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { builtinPdfText } from '@/services/pdf-text';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import type { User, UserRole } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * TWO DECISIONS, BOTH ANSWERED BY THE OWNER ON 23 OCTOBER 2026.
 * BD-17, BD-18.
 *
 * BD-17 — MAY THE ISSUED PRICES BE EXPORTED, AND BY WHOM? **The office: a
 * Master and a Coordinator.** A technician may not, and these cases assert that
 * against the FILE BYTES as well as the column list — a column list that
 * drifted from the writer would pass the cheap assertion and leak the money.
 *
 * BD-18 — IS AN EXPORT RECORDED ON THE AUDIT TRAIL? **Yes, all of them, kept
 * indefinitely.** There is no longer any configuration that turns it off, and
 * one case below proves that by setting the old variable to "off" and watching
 * the event be written anyway.
 *
 * WHAT STAYS TRUE WHICHEVER WAY THEY HAD ANSWERED: the audit record names which
 * COLUMNS were taken and never the rows, and the figures come from the
 * write-once pricing snapshot rather than being recomputed from today's rates.
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
        pdfText: builtinPdfText(),
        storage: new DemoStorageService(inMemoryFileStore()),
      },
    },
  };
};

describe('BD-17: the issued prices, now that the office may export them', () => {
  /*
   * EVERY ROLE THE SYSTEM HAS. Listed here because `UserRole` is a type union
   * with no runtime list beside it — and the `satisfies` is what makes a role
   * added later fail to compile until somebody decides whether it may export
   * the money.
   */
  const roles = ['master', 'coordinator', 'technician'] satisfies readonly UserRole[];

  it('are in the OFFICE’s export, and in no technician’s', () => {
    const permitted = new Set(['master', 'coordinator']);

    for (const role of roles) {
      const headers = closedJobColumnsFor({ role }).map((column) => column.header);
      for (const priced of closedJobPriceColumns) {
        if (permitted.has(role)) {
          expect(headers, `${role} / ${priced}`).toContain(priced);
        } else {
          expect(headers, `${role} / ${priced}`).not.toContain(priced);
        }
      }
    }
  });

  it('are in the BYTES of a Master’s export', async () => {
    const harness = build();
    const file = await exportClosedJobs(harness.repos, master, emptyClosedJobFilters);

    expect(file.csv.length).toBeGreaterThan(0);
    for (const priced of closedJobPriceColumns) {
      expect(file.csv).toContain(priced);
    }
    // And the reported columns match the file, which is what the audit record
    // names.
    for (const header of file.columns) expect(file.csv).toContain(header);
  });

  it('are in the BYTES of a Coordinator’s export too', async () => {
    const coordinator = seedUsers.find((user) => user.role === 'coordinator')!;
    const harness = build(coordinator);
    const file = await exportClosedJobs(harness.repos, coordinator, emptyClosedJobFilters);

    for (const priced of closedJobPriceColumns) {
      expect(file.csv).toContain(priced);
    }
  });

  it('pins the four columns and their order, so the shape of the answer is visible', () => {
    expect(closedJobPriceColumns).toEqual([
      'Subtotal (excl. VAT)',
      'VAT',
      'Total (incl. VAT)',
      'Priced at',
    ]);
  });

  it('come from the FROZEN snapshot, never recomputed from today’s rates', async () => {
    /*
     * The figures are read from `listIssuedTotals`, which reads the write-once
     * `pricing_snapshots` columns. A job with no snapshot exports an EMPTY cell
     * rather than "0.00" — a zero is a figure people believe.
     */
    const harness = build();
    const file = await exportClosedJobs(harness.repos, master, emptyClosedJobFilters);
    const lines = file.csv.split('\r\n').filter((line) => line.length > 0);

    expect(lines.length).toBeGreaterThan(1);
    // No row claims a zero total: either a real figure or nothing at all.
    for (const line of lines.slice(1)) {
      expect(line).not.toMatch(/,"?0\.00"?,/u);
    }
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

  it('CANNOT BE TURNED OFF, which is what "audit all exports" means', async () => {
    /*
     * The old `EJE_EXPORT_AUDIT` is no longer read anywhere. Setting it to the
     * value that used to mean "off" must change nothing — this is the case that
     * would fail if somebody reintroduced a switch.
     */
    process.env.EJE_EXPORT_AUDIT = 'off';
    const harness = build();
    const before = (await harness.repos.activity.list(undefined)).length;

    const outcome = await recordExport(harness.context, record(harness, 12));

    expect(outcome.written).toBe(true);
    expect((await harness.repos.activity.list(undefined)).length).toBe(before + 1);
  });

  it('writes the event with the variable unset, too', async () => {
    delete process.env.EJE_EXPORT_AUDIT;
    const harness = build();
    const before = (await harness.repos.activity.list(undefined)).length;

    await recordExport(harness.context, record(harness, 4));

    expect((await harness.repos.activity.list(undefined)).length).toBe(before + 1);
  });

  it('WRITES A REAL EVENT, with the figures and the filters', async () => {
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
