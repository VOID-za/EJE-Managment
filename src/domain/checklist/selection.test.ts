import { describe, expect, it } from 'vitest';
import {
  installationChecklist,
  latheServiceChecklist,
  millingServiceChecklist,
  sourceChecklists,
} from '@/data/checklists/source-checklists';
import type { ChecklistTemplate } from '../types/checklist';
import {
  checklistChoiceRequired,
  checklistOptions,
  cleanFieldValues,
  formatFieldValues,
  orderChecklistOptions,
  resolveChecklistToStart,
} from './selection';
import { checklistItemLabel } from './validation';

/** The demonstration wording, archived by CHK-SRC-1. */
const demoService: ChecklistTemplate = {
  ...millingServiceChecklist,
  id: 'chk-service' as ChecklistTemplate['id'],
  name: 'Preventative Service Checklist',
  version: '2.0-DEMO',
  status: 'archived',
  kind: null,
  selectionLabel: '',
  layout: null,
};

describe('which checklist a job may start (CHK-SRC-1)', () => {
  const all = [demoService, ...sourceChecklists];

  it('offers Service the Milling and Lathe checklists, Milling first, and never the archived demonstration wording', () => {
    const options = orderChecklistOptions(checklistOptions([...all].reverse(), 'service'));
    expect(options.map((option) => option.kind)).toEqual(['service_milling', 'service_lathe']);
    expect(checklistChoiceRequired(options)).toBe(true);
  });

  it('offers Installation its one checklist, with no choice to make', () => {
    const options = checklistOptions(all, 'installation');
    expect(options.map((option) => option.kind)).toEqual(['installation']);
    expect(checklistChoiceRequired(options)).toBe(false);
  });

  it('refuses a Service start with no choice, and never falls back to a default', () => {
    const resolution = resolveChecklistToStart(checklistOptions(all, 'service'), undefined);
    expect(resolution).toMatchObject({ ok: false, code: 'checklist_selection_required' });
  });

  it('opens exactly the checklist chosen', () => {
    const options = checklistOptions(all, 'service');
    expect(resolveChecklistToStart(options, latheServiceChecklist.id)).toEqual({
      ok: true,
      template: latheServiceChecklist,
    });
    expect(resolveChecklistToStart(options, millingServiceChecklist.id)).toEqual({
      ok: true,
      template: millingServiceChecklist,
    });
  });

  it('refuses a choice that is not one of the options — including archived wording and another type’s', () => {
    const options = checklistOptions(all, 'service');
    for (const wrong of [demoService.id, installationChecklist.id, 'nonsense']) {
      expect(resolveChecklistToStart(options, wrong)).toMatchObject({
        ok: false,
        code: 'checklist_selection_invalid',
      });
    }
  });

  it('starts Installation with no choice named', () => {
    expect(resolveChecklistToStart(checklistOptions(all, 'installation'), undefined)).toEqual({
      ok: true,
      template: installationChecklist,
    });
  });

  it('says so when nothing is issued for the type', () => {
    expect(resolveChecklistToStart([], undefined)).toMatchObject({
      ok: false,
      code: 'checklist_not_configured',
    });
  });
});

describe('the printed blanks', () => {
  const voltage = installationChecklist.sections[0]!.items[1]!; // 2 Check electrical voltage
  const pressure = installationChecklist.sections[0]!.items[4]!; // 5 Lubrication pressure

  it('keeps the row’s own blanks, trimmed, drops emptied ones, and names unknown ones', () => {
    expect(cleanFieldValues(voltage, { r: ' 401 ', s: '', t: '400' })).toEqual({
      values: { r: '401', t: '400' },
      unknown: [],
    });
    expect(cleanFieldValues(voltage, { x: '1' }).unknown).toEqual(['x']);
  });

  it('formats them with the paper’s labels and units', () => {
    expect(formatFieldValues(voltage, { fieldValues: { r: '401', s: '399', t: '400' } })).toBe(
      'R 401 · S 399 · T 400',
    );
    expect(formatFieldValues(pressure, { fieldValues: { value: '2.5' } })).toBe('2.5 Bar/PSI');
    expect(formatFieldValues(pressure, undefined)).toBe('');
  });
});

describe('how a message names a row', () => {
  it('uses the printed number and group, on one line', () => {
    const rows = installationChecklist.sections[0]!.items;
    expect(checklistItemLabel(rows[6]!)).toBe('7 Check all oil levels: Hydraulic Oil');
    expect(checklistItemLabel(rows.at(-1)!)).toBe(
      '31 Download a maintenance file/back up If Siemens: Extract XML File',
    );
    const handwritten = latheServiceChecklist.sections[1]!.items[5]!;
    expect(checklistItemLabel(handwritten)).toBe('Changed Fanuc control battery');
  });
});
