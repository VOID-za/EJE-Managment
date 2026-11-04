import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChecklistTemplate } from '@/domain';
import {
  installationChecklist,
  latheServiceChecklist,
  millingServiceChecklist,
  sourceChecklists,
} from './source-checklists';

/**
 * THE CHECKLISTS EJE ISSUES ARE THE SOURCE DOCUMENTS. CHK-SRC-1.
 *
 * `docs/source-checklists/TRANSCRIPTION.md` is the record a person checks,
 * table by table, against the three scanned PDFs. This proves the module the
 * application (and migration 0051, by `source-checklists.db.test.ts`) issues
 * is that record exactly — every row's number, group, wording, printed blanks
 * and source note, in order, with nothing added and nothing missing — and pins
 * the counts and the wording the owner asked about by name.
 */

const RECORD = readFileSync(
  join(import.meta.dirname, '../../../docs/source-checklists/TRANSCRIPTION.md'),
  'utf8',
).replace(/\r\n/gu, '\n');

interface RecordedRow {
  readonly number: string;
  readonly group: string;
  readonly text: string;
  readonly blanks: string;
  readonly sourceNote: string;
}

const unescapeCell = (cell: string): string =>
  cell.trim().replace(/<br>/gu, '\n').replace(/\\\|/gu, '|');

/** The record's chapter for one checklist: its bullet lines and its row tables, by section. */
const chapter = (name: string) => {
  const start = RECORD.indexOf(`\n## ${name}\n`);
  if (start === -1) throw new Error(`The transcription record has no chapter "${name}"`);
  const next = RECORD.indexOf('\n## ', start + 4);
  const text = RECORD.slice(start, next === -1 ? undefined : next);

  const bullet = (label: string): string =>
    (text.match(new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, 'mu'))?.[1] ?? '').trim();

  const sections: { title: string; rows: RecordedRow[] }[] = [];
  let current: { title: string; rows: RecordedRow[] } | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('### ')) {
      current = { title: line.slice(4).trim(), rows: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith('| No. |')) {
      if (current === null || current.rows.length > 0) {
        current = { title: '', rows: [] };
        sections.push(current);
      }
      continue;
    }
    if (!line.startsWith('| ') || line.startsWith('|---')) continue;
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/u)
      .map(unescapeCell);
    current!.rows.push({
      number: cells[0] ?? '',
      group: cells[1] ?? '',
      text: cells[2] ?? '',
      blanks: cells[3] ?? '',
      sourceNote: cells[4] ?? '',
    });
  }
  return { bullet, sections, text };
};

const rowsOf = (template: ChecklistTemplate) =>
  template.sections.map((section) => ({
    title: section.title,
    rows: section.items.map((item) => ({
      number: item.number ?? '',
      group: item.group ?? '',
      text: item.text,
      blanks: (item.fields ?? [])
        .map((field) => [field.label, '___', field.unit].filter((part) => part.length > 0).join(' '))
        .join(' · '),
      sourceNote: item.sourceNote ?? '',
    })),
  }));

const count = (template: ChecklistTemplate) =>
  template.sections.reduce((total, section) => total + section.items.length, 0);

describe('each checklist is its transcription record, row for row', () => {
  for (const template of sourceChecklists) {
    it(`${template.name}: every row, in order, with nothing added or missing`, () => {
      const recorded = chapter(template.name);
      expect(rowsOf(template)).toEqual(recorded.sections);
    });

    it(`${template.name}: the printed title, header, columns, notes and sign-off`, () => {
      const recorded = chapter(template.name);
      const layout = template.layout!;
      expect(recorded.bullet('Printed title')).toBe(layout.title);
      expect(recorded.bullet('Header lines')).toBe(
        layout.headerFields.map((field) => field.label).join(' · '),
      );
      expect(recorded.bullet('Columns')).toBe(
        Object.values(layout.columns)
          .map((heading) => (heading.length === 0 ? '(blank)' : heading))
          .join(' · '),
      );
      expect(recorded.text).toContain(
        `**Sign-off:** ${layout.signatures.map((line) => line.label).join(' · ')}`,
      );
      for (const note of layout.notes) expect(recorded.text).toContain(`- ${note}`);
      if (layout.closing.length > 0) {
        expect(recorded.text).toContain(`**Closing line:** ${layout.closing}`);
      }
      expect(recorded.bullet('Rows')).toMatch(new RegExp(`^${count(template)} `, 'u'));
    });
  }
});

describe('Installation — installation.pdf', () => {
  const rows = installationChecklist.sections.flatMap((section) => section.items);

  it('has 31 numbered procedures, 1 to 31 in order, as 36 rows', () => {
    expect(rows).toHaveLength(36);
    expect([...new Set(rows.map((item) => item.number))]).toEqual(
      Array.from({ length: 31 }, (_, index) => String(index + 1)),
    );
  });

  it('keeps item 7 as six oils under one printed heading', () => {
    const seven = rows.filter((item) => item.number === '7');
    expect(seven.map((item) => item.text)).toEqual([
      'Hydraulic Oil',
      'Chiller Unit Oil',
      'Turret Oil',
      'Tool Arm gearbox Oil',
      'Air Lube Oil',
      'Lubrication Oil',
    ]);
    expect(new Set(seven.map((item) => item.group))).toEqual(new Set(['Check all oil levels:']));
  });

  it('keeps the measurement blanks the paper prints', () => {
    const blanks = (number: string) =>
      rows.find((item) => item.number === number)?.fields?.map((field) => `${field.label}|${field.unit}`);
    expect(blanks('2')).toEqual(['R|', 'S|', 'T|']);
    expect(blanks('3')).toEqual(['R|', 'S|', 'T|']);
    expect(blanks('5')).toEqual(['|Bar/PSI']);
    expect(blanks('6')).toEqual(['On time:|', 'Off time:|']);
    expect(blanks('12')).toEqual(['|KPA/PSI']);
    expect(blanks('13')).toEqual(['|KPA/PSI']);
    expect(blanks('14')).toEqual(['|KPA']);
    expect(blanks('15')).toEqual(['|KPA (0.2)']);
  });

  it('keeps the wording exactly, including the source’s own grammar', () => {
    expect(rows[0]?.text).toBe('Tightness check on all electrical connections');
    expect(rows.find((item) => item.number === '19')?.text).toBe(
      'Do a actual tool change with 2 tool holders',
    );
    expect(rows.at(-1)?.text).toBe('Download a maintenance file/back up\nIf Siemens: Extract XML File');
    expect(installationChecklist.layout?.title).toBe('Installation Procedure');
    expect(installationChecklist.layout?.notes).toEqual([
      'Please hand in all documents to Juanita & e-mail XML/backup/maintenance file to jhb@wdhearn.co.za',
      'If procedure is not filled in and correctly filled in, no training will be scheduled.',
    ]);
  });
});

describe('Service — Milling Machine — service-milling.pdf', () => {
  it('has the eight printed sections, in order, numbered from 1 in each', () => {
    expect(millingServiceChecklist.sections.map((section) => section.title)).toEqual([
      'GENERAL',
      'ELECTRICAL',
      'LUBRICATION',
      'HYDRAULICS',
      'PNEUMATICS',
      'COOLANT',
      'BACK UP',
      'THERMAL CHECK',
    ]);
    expect(millingServiceChecklist.sections.map((section) => section.items.length)).toEqual([
      14, 11, 4, 2, 3, 3, 1, 1,
    ]);
    for (const section of millingServiceChecklist.sections) {
      expect(section.items.map((item) => item.number)).toEqual(
        section.items.map((_, index) => String(index + 1)),
      );
    }
    expect(count(millingServiceChecklist)).toBe(39);
  });

  it('keeps the printed spelling and the conditional notes', () => {
    const general = millingServiceChecklist.sections[0]!.items;
    expect(general[12]?.text).toBe('Check Spindle Drive belt for wear and tention');
    expect(general[13]?.text).toBe('APC (if fitted)\nCheck accuracy of APC and check clamping faces for wear');
    expect(millingServiceChecklist.sections[1]!.items[10]?.text).toBe('Replaced FANUC control battery');
    expect(millingServiceChecklist.sections[3]!.items[1]?.text).toBe(
      'SPINDLE OIL COOLER Checkoil and check air filters. Airblast clean the condenser cooling fans',
    );
    expect(millingServiceChecklist.layout?.closing).toBe('ALL CHECKS COMPLETE');
  });
});

describe('Service — Lathe — service-lathe.pdf', () => {
  const electrical = latheServiceChecklist.sections.find((section) => section.title === 'ELECTRICAL')!;

  it('has its own seven sections — no COOLANT — and 41 rows', () => {
    expect(latheServiceChecklist.sections.map((section) => section.title)).toEqual([
      'GENERAL',
      'ELECTRICAL',
      'LUBRICATION',
      'HYDRAULICS',
      'PNEUMATICS',
      'BACK UP',
      'THERMAL CHECK',
    ]);
    expect(count(latheServiceChecklist)).toBe(41);
    expect(latheServiceChecklist.layout?.title).toBe('PREVENTATIVE MAINTENACE CHECKLIST - LATHE');
  });

  it('keeps the handwritten addition, marked as handwritten, where the paper has it', () => {
    expect(electrical.items.map((item) => item.number)).toEqual([
      '1', '2', '3', '4', '5', '', '', '6', '7', '8', '9', '10',
    ]);
    expect(electrical.items[5]).toMatchObject({
      number: '',
      text: 'Changed Fanuc control battery',
      sourceNote: 'Handwritten on the supplied source.',
    });
    expect(electrical.items[6]).toMatchObject({
      number: '',
      text: 'Check & clean electrical motor fans',
    });
  });

  it('is not the Milling checklist', () => {
    const lathe = latheServiceChecklist.sections.flatMap((section) => section.items.map((item) => item.text));
    const milling = millingServiceChecklist.sections.flatMap((section) => section.items.map((item) => item.text));
    expect(lathe).not.toEqual(milling);
    expect(lathe).toContain('Check Turret alignment X and Z Axis');
    expect(milling).not.toContain('Check Turret alignment X and Z Axis');
    expect(latheServiceChecklist.id).not.toBe(millingServiceChecklist.id);
  });
});

describe('every source row', () => {
  const all = sourceChecklists.flatMap((template) =>
    template.sections.flatMap((section) => section.items),
  );

  it('is answered as the paper is — a tick (Pass / Fail / N/A) and a comment — and is required', () => {
    for (const item of all) {
      expect(item.responseType).toBe('pass_fail_na');
      expect(item.required).toBe(true);
      expect(item.photoRequired).toBe(false);
      expect(item.helpText).toBe('');
    }
  });

  it('has its own id, across all three checklists', () => {
    const ids = [
      ...sourceChecklists.map((template) => template.id as string),
      ...sourceChecklists.flatMap((template) => template.sections.map((section) => section.id)),
      ...all.map((item) => item.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it('is issued as version 1.0 of its own checklist, with its kind', () => {
    expect(sourceChecklists.map((template) => [template.kind, template.jobTypeCode, template.version, template.status])).toEqual([
      ['installation', 'installation', '1.0', 'current'],
      ['service_milling', 'service', '1.0', 'current'],
      ['service_lathe', 'service', '1.0', 'current'],
    ]);
  });
});
