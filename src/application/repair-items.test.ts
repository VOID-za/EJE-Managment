import { beforeEach, describe, expect, it } from 'vitest';
import { REPAIR_ITEMS_MAX, repairItemsOf, storedRepairItems, type RepairItem } from '@/domain';
import { buildDeliveryNoteModel } from '@/lib/job-card/delivery-note';
import { buildJobCardModel } from '@/lib/job-card/model';
import { inspectPdf, pdfPageTexts } from '@/lib/pdf/inspect';
import { renderDeliveryNotePdf } from '@/services/simulated/delivery-note-pdf';
import { renderJobCardPdf } from '@/services/simulated/job-card-pdf';
import { loadJobView } from './job-view';
import { normaliseRepairItems, setRepairItems } from './repair-items';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';

/*
 * TR-PARTS-1 (the tester, 31 October 2026): one Test & Repair job — and its
 * one delivery note — carries any number of different parts, each with its
 * own part number and quantity. EJE-1067 is the seeded Test & Repair job.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const FOUR: readonly RepairItem[] = [
  { description: 'Bearing', partNumber: 'BRG-001', quantity: 2 },
  { description: 'Seal kit', partNumber: 'SK-010', quantity: 1 },
  { description: 'Sensor', partNumber: 'SNS-004', quantity: 3 },
  { description: 'Coupling', partNumber: 'CPL-002', quantity: 1 },
];

const codes = async (work: Promise<unknown>): Promise<string[]> => {
  const error = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowError);
  return (error as WorkflowError).violations.map((violation) => violation.code);
};

const testAndRepair = async (harness: Harness) => (await harness.repos.jobs.findByJobNumber('EJE-1067'))!;

describe('the rules for one part', () => {
  it('trims, keeps order, and drops rows with nothing in them', () => {
    expect(normaliseRepairItems([
      { description: '  Bearing ', partNumber: ' BRG-001 ', quantity: 2 },
      { description: '', partNumber: '', quantity: null },
      { description: 'Seal kit', partNumber: '', quantity: null },
    ])).toEqual([
      { description: 'Bearing', partNumber: 'BRG-001', quantity: 2 },
      { description: 'Seal kit', partNumber: '', quantity: null },
    ]);
  });

  it('refuses a quantity that is not a positive whole number; keeps a part with only a quantity, as before', () => {
    expect(() => normaliseRepairItems([{ description: 'Bearing', partNumber: '', quantity: 0 }])).toThrow(WorkflowError);
    expect(() => normaliseRepairItems([{ description: 'Bearing', partNumber: '', quantity: 1.5 }])).toThrow(WorkflowError);
    expect(normaliseRepairItems([{ description: '', partNumber: '', quantity: 3 }])).toEqual([{ description: '', partNumber: '', quantity: 3 }]);
    expect(() => normaliseRepairItems(Array.from({ length: REPAIR_ITEMS_MAX + 1 }, (_, i) => ({ description: `P${i}`, partNumber: '', quantity: 1 })))).toThrow(WorkflowError);
  });

  it('stores the first part where the single item always lived, and the rest after it', () => {
    const stored = storedRepairItems(FOUR);
    expect(stored.repairItem).toEqual(FOUR[0]);
    expect(stored.moreRepairItems).toEqual(FOUR.slice(1));
    expect(repairItemsOf(stored)).toEqual(FOUR);
  });
});

describe('changing the parts on a Test & Repair job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('adds four different parts with their own quantities; reopened, all four are there in order', async () => {
    const job = await testAndRepair(harness);
    const saved = await setRepairItems(harness.as(master), job, { items: FOUR, expected: repairItemsOf(job) });
    expect(repairItemsOf(saved)).toEqual(FOUR);
    const reopened = (await harness.repos.jobs.findByJobNumber('EJE-1067'))!;
    expect(repairItemsOf(reopened)).toEqual(FOUR);
    const trail = await harness.repos.activity.list(reopened.id);
    expect(trail.some((event) => event.type === 'job_details_edited' && event.changes.some((change) => change.field === 'details.repairItems'))).toBe(true);
  });

  it('edits a quantity and removes a part, as the Coordinator', async () => {
    let job = await setRepairItems(harness.as(master), await testAndRepair(harness), { items: FOUR, expected: repairItemsOf(await testAndRepair(harness)) });
    const edited = [FOUR[0]!, { ...FOUR[2]!, quantity: 5 }, FOUR[3]!];
    job = await setRepairItems(harness.as(coordinator), job, { items: edited, expected: FOUR });
    expect(repairItemsOf(job)).toEqual(edited);
  });

  it('refuses a technician, a job type that books in no parts, and a stale list', async () => {
    const job = await testAndRepair(harness);
    expect(await codes(setRepairItems(harness.as(technician), job, { items: FOUR, expected: repairItemsOf(job) }))).toEqual(['not_permitted']);
    const breakdown = (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;
    expect(await codes(setRepairItems(harness.as(master), breakdown, { items: FOUR, expected: [] }))).toEqual(['not_applicable_to_job_type']);
    await setRepairItems(harness.as(master), job, { items: FOUR, expected: repairItemsOf(job) });
    const stale = (await harness.repos.jobs.findByJobNumber('EJE-1067'))!;
    expect(await codes(setRepairItems(harness.as(coordinator), stale, { items: [FOUR[0]!], expected: repairItemsOf(job) }))).toEqual(['job_details_changed']);
  });
});

describe('the one delivery note carries every part', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const noteFor = async (items: readonly RepairItem[]) => {
    const job = await testAndRepair(harness);
    await harness.repos.jobs.save({ ...job, courierCollection: true, ...storedRepairItems(items) });
    const view = await loadJobView(harness.repos, 'EJE-1067');
    return buildDeliveryNoteModel(view!, '2026-10-31T16:00:00.000Z');
  };

  it('lists all four parts with their part numbers and quantities, and the total', async () => {
    const model = await noteFor(FOUR);
    const booked = model.items.filter((item) => item.kind === 'Repaired unit');
    expect(booked.map((item) => [item.description, item.partNumber, item.quantity])).toEqual([
      ['Bearing', 'BRG-001', '2'], ['Seal kit', 'SK-010', '1'], ['Sensor', 'SNS-004', '3'], ['Coupling', 'CPL-002', '1'],
    ]);
    const rendered = renderDeliveryNotePdf(model);
    const text = pdfPageTexts(rendered.bytes).join('\n');
    for (const value of ['BRG-001', 'SK-010', 'SNS-004', 'CPL-002', 'Bearing', 'Seal kit', 'Sensor', 'Coupling']) expect(text).toContain(value);
    expect(inspectPdf(rendered.bytes, { margin: 40, edge: 12 }).problems).toEqual([]);
  });

  it('continues onto further pages with the headings repeated, numbered, nothing clipped or overlapping', async () => {
    const many = Array.from({ length: 70 }, (_, index) => ({
      description: `Replacement part ${index + 1} — ${index % 4 === 0 ? 'a long description that wraps onto a second line inside its own column without running into the quantity' : 'bearing'}`,
      partNumber: `PN-${String(index + 1).padStart(3, '0')}${index % 5 === 0 ? '-A06B-6114-H208#H580' : ''}`,
      quantity: (index % 9) + 1,
    }));
    const model = await noteFor(many);
    const rendered = renderDeliveryNotePdf(model);
    expect(rendered.pageCount).toBeGreaterThan(1);
    const pages = pdfPageTexts(rendered.bytes);
    expect(pages).toHaveLength(rendered.pageCount);
    for (const [index, page] of pages.entries()) {
      expect(page).toContain(`Page ${index + 1} of ${rendered.pageCount}`);
      if (index > 0 && page.includes('PN-')) {
        expect(page).toContain('Goods (continued)');
        expect(page).toContain('Part number');
      }
    }
    const all = pages.join('\n');
    for (let index = 1; index <= 70; index += 1) expect(all).toContain(`PN-${String(index).padStart(3, '0')}`);
    expect(model.totalQuantity).toBe(String(many.reduce((total, item) => total + item.quantity, 0) + model.items.filter((item) => item.kind === 'Part').reduce((total, item) => total + Number(item.quantity), 0)));
    expect(inspectPdf(rendered.bytes, { margin: 40, edge: 12 }).problems).toEqual([]);
  });

  it('one part reads exactly as it always did on the job card', async () => {
    const job = await testAndRepair(harness);
    await harness.repos.jobs.save({ ...job, ...storedRepairItems([FOUR[0]!]) });
    const view = (await loadJobView(harness.repos, 'EJE-1067'))!;
    const card = buildJobCardModel({ ...view, generatedAt: '2026-10-31T16:00:00.000Z' });
    const labels = JSON.stringify(card);
    expect(labels).toContain('"Part number"');
    expect(labels).toContain('"Quantity received"');
    expect(labels).not.toContain('Part 1 received');
  });

/*
 * PDF-RECV-1 (the tester, 1 November 2026): "Part 1 received … Part 2 received
 * … Collection" were printed under JOB DETAILS. They belong in LABOUR, TRAVEL
 * AND PARTS — moved there, not duplicated, descriptions and quantities intact.
 */
describe('parts received on the job card PDF (PDF-RECV-1)', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const pdfText = async (items: readonly RepairItem[], courier = false) => {
    const job = await testAndRepair(harness);
    await harness.repos.jobs.save({ ...job, courierCollection: courier, waybillNumber: courier ? 'WB-7781' : '', ...storedRepairItems(items) });
    const view = (await loadJobView(harness.repos, 'EJE-1067'))!;
    const rendered = renderJobCardPdf({ ...view, photoImages: new Map() } as never, 'EJE-1067.pdf', '2026-11-01T10:00:00.000Z');
    expect(inspectPdf(rendered.bytes, { margin: 40, edge: 12 }).problems).toEqual([]);
    return { text: pdfPageTexts(rendered.bytes).join(' '), model: buildJobCardModel({ ...view, generatedAt: '2026-11-01T10:00:00.000Z' }) };
  };
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it('prints every part received and the collection under Labour, travel and parts, once, and nothing of them under Job details', async () => {
    const { text, model } = await pdfText(FOUR);
    const details = text.indexOf('JOB DETAILS');
    const section = text.indexOf('LABOUR, TRAVEL AND PARTS');
    expect(details).toBeGreaterThanOrEqual(0);
    expect(section).toBeGreaterThan(details);
    for (const [index, item] of FOUR.entries()) {
      const label = `Part ${index + 1} received`;
      expect(count(text, label)).toBe(1);
      expect(text.indexOf(label)).toBeGreaterThan(section);
      expect(text).toContain(item.description);
    }
    expect(count(text, 'Customer collection')).toBe(1);
    expect(text.indexOf('Customer collection')).toBeGreaterThan(section);
    // The model agrees: nothing received under Job details, all of it in `received`.
    expect(model.jobDetails.some((row) => /received$|^Collection$|^Waybill$/u.test(row.label))).toBe(false);
    expect(model.received?.rows.map((row) => row.label)).toEqual(['Part 1 received', 'Part 2 received', 'Part 3 received', 'Part 4 received', 'Collection']);
    expect(model.received?.rows[0]?.value).toBe('Bearing (BRG-001) × 2');
  });

  it('a courier collection carries its waybill there too', async () => {
    const { text } = await pdfText(FOUR.slice(0, 2), true);
    const section = text.indexOf('LABOUR, TRAVEL AND PARTS');
    expect(count(text, 'Courier collection')).toBe(1);
    expect(text.indexOf('Courier collection')).toBeGreaterThan(section);
    expect(text.indexOf('WB-7781')).toBeGreaterThan(section);
  });
});
});
