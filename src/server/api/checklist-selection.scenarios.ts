import { expect } from 'vitest';
import {
  installationChecklist,
  latheServiceChecklist,
  millingServiceChecklist,
} from '@/data/checklists/source-checklists';
import type { ApiTestClient } from '@/test/api-harness';

/**
 * THE SERVICE CHECKLIST CHOICE, THROUGH THE API. CHK-SRC-1.
 *
 * One set of scenarios, run twice: against the demonstration backend
 * (`checklist-selection-api.test.ts`) and against PostgreSQL
 * (`checklist-selection.db.test.ts`), because the rule is the server's and must
 * hold on the store the business actually runs.
 */

export interface ChecklistBody {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly checklistKind?: string | null;
  readonly completedAt: string | null;
  readonly responses: readonly {
    readonly itemId: string;
    readonly choice: string | null;
    readonly notes: string;
    readonly fieldValues?: Readonly<Record<string, string>>;
  }[];
}

export interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
  readonly checklist: ChecklistBody | null;
}

export interface ScenarioContext {
  /** The office, who creates the job. */
  readonly master: () => Promise<ApiTestClient>;
  /** The technician the job is assigned to. */
  readonly technician: () => Promise<ApiTestClient>;
  /** A technician who is NOT on the job. */
  readonly otherTechnician: () => Promise<ApiTestClient>;
  /** The technician's user id, to assign the job to. */
  readonly technicianId: (master: ApiTestClient) => Promise<string>;
  /** Customer, site, contact and machine ids valid on this backend. */
  readonly record: {
    readonly customerId: string;
    readonly siteId: string;
    readonly contactId: string;
    readonly machineId: string;
  };
}

const rows = (template: typeof installationChecklist) =>
  template.sections.flatMap((section) => section.items);

/** A job of this type, accepted by its technician and ready for a checklist. */
export const acceptedJob = async (
  context: ScenarioContext,
  jobType: 'installation' | 'service',
): Promise<{ job: JobBody; tech: ApiTestClient }> => {
  const master = await context.master();
  const created = await master.post<JobBody>('/api/jobs', {
    ...context.record,
    jobType,
    priority: 'normal',
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: 'PO-55120',
    referenceNumber: '',
    faultDescription: jobType === 'service' ? 'Annual preventative maintenance.' : 'New machine.',
    primaryTechnicianId: await context.technicianId(master),
    courierCollection: false,
    deliveryNote: '',
  });
  expect(created.status).toBe(200);
  const tech = await context.technician();
  expect((await tech.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(200);
  return { job: created.data, tech };
};

interface ViewBody {
  readonly job: JobBody;
  readonly checklistTemplate: { readonly id: string } | null;
  readonly checklistChoiceRequired: boolean;
  readonly checklistOptions: readonly { readonly id: string; readonly selectionLabel?: string }[];
}

const view = async (client: ApiTestClient, job: JobBody): Promise<ViewBody> => {
  const response = await client.get<{ view: ViewBody }>(`/api/jobs/${job.jobNumber}`);
  expect(response.status).toBe(200);
  return response.data.view;
};

const start = (tech: ApiTestClient, job: JobBody, templateId?: string) =>
  tech.post<JobBody>(
    `/api/jobs/${job.id}/start_checklist`,
    templateId === undefined ? {} : { templateId },
  );

export const scenarios = (context: ScenarioContext) => ({
  async 'refuses to open a Service checklist until Milling or Lathe is chosen'() {
    const { job, tech } = await acceptedJob(context, 'service');
    const bare = await start(tech, job);
    expect(bare.status).toBe(422);
    expect(bare.error?.violations?.[0]?.code).toBe('checklist_selection_required');
    expect(bare.error?.message).toContain('Milling Machine / Machining Centre or Lathe');

    // Nothing was started: no generic checklist was opened behind the refusal,
    // and the job still offers exactly the two choices.
    const after = await view(tech, job);
    expect(after.job.checklist).toBeNull();
    expect(after.checklistTemplate).toBeNull();
    expect(after.checklistChoiceRequired).toBe(true);
    expect(after.checklistOptions.map((option) => option.selectionLabel)).toEqual([
      'Milling Machine / Machining Centre',
      'Lathe',
    ]);
  },

  async 'opens only the Lathe checklist on a Lathe choice, and records the choice'() {
    const { job, tech } = await acceptedJob(context, 'service');
    const opened = await start(tech, job, latheServiceChecklist.id);
    expect(opened.status).toBe(200);
    expect(opened.data.checklist?.templateId).toBe(latheServiceChecklist.id);
    expect(opened.data.checklist?.templateVersion).toBe('1.0');
    expect(opened.data.checklist?.checklistKind).toBe('service_lathe');
    expect(opened.data.checklist?.responses.map((response) => response.itemId)).toEqual(
      rows(latheServiceChecklist).map((item) => item.id),
    );

    // The choice cannot be changed by starting again with the other one.
    const again = await start(tech, job, millingServiceChecklist.id);
    expect(again.status).toBe(200);
    expect(again.data.checklist?.templateId).toBe(latheServiceChecklist.id);
  },

  async 'opens only the Milling checklist on a Milling choice'() {
    const { job, tech } = await acceptedJob(context, 'service');
    const opened = await start(tech, job, millingServiceChecklist.id);
    expect(opened.status).toBe(200);
    expect(opened.data.checklist?.templateId).toBe(millingServiceChecklist.id);
    expect(opened.data.checklist?.checklistKind).toBe('service_milling');
    expect(opened.data.checklist?.responses).toHaveLength(39);
  },

  async 'refuses a choice that is not a current Service checklist'() {
    const { job, tech } = await acceptedJob(context, 'service');
    for (const wrong of [installationChecklist.id, '00000000-0000-4000-8000-0000000000ff']) {
      const refused = await start(tech, job, wrong);
      expect(refused.status).toBe(422);
      expect(refused.error?.violations?.[0]?.code).toBe('checklist_selection_invalid');
    }
  },

  async 'opens Installation directly, with no choice, and refuses a Service checklist on it'() {
    const { job, tech } = await acceptedJob(context, 'installation');
    const wrong = await start(tech, job, millingServiceChecklist.id);
    expect(wrong.status).toBe(422);
    expect(wrong.error?.violations?.[0]?.code).toBe('checklist_selection_invalid');

    const opened = await start(tech, job);
    expect(opened.status).toBe(200);
    expect(opened.data.checklist?.templateId).toBe(installationChecklist.id);
    expect(opened.data.checklist?.checklistKind).toBe('installation');
    expect(opened.data.checklist?.responses).toHaveLength(36);
  },

  async 'refuses a technician who is not on the job'() {
    const { job } = await acceptedJob(context, 'service');
    const other = await context.otherTechnician();
    const refused = await start(other, job, latheServiceChecklist.id);
    expect(refused.status).not.toBe(200);
    const tech = await context.technician();
    expect((await view(tech, job)).job.checklist).toBeNull();
  },

  async 'accepts answers only to the chosen checklist’s own rows and blanks'() {
    const { job, tech } = await acceptedJob(context, 'installation');
    expect((await start(tech, job)).status).toBe(200);
    const voltage = rows(installationChecklist)[1]!; // 2 Check electrical voltage: R / S / T
    const tightness = rows(installationChecklist)[0]!; // 1 — no blanks

    // A row from another checklist is not on this one.
    const foreign = await tech.post(`/api/jobs/${job.id}/answer_checklist`, {
      itemId: rows(latheServiceChecklist)[0]!.id,
      choice: 'pass',
    });
    expect(foreign.status).toBe(422);
    expect(foreign.error?.violations?.[0]?.code).toBe('checklist_item_unknown');

    // A blank the row does not print.
    const noBlank = await tech.post(`/api/jobs/${job.id}/answer_checklist`, {
      itemId: tightness.id,
      fieldValues: { r: '400' },
    });
    expect(noBlank.status).toBe(422);
    expect(noBlank.error?.violations?.[0]?.code).toBe('checklist_field_unknown');

    // R, then S: each blank is kept, the second does not erase the first.
    expect(
      (await tech.post(`/api/jobs/${job.id}/answer_checklist`, { itemId: voltage.id, fieldValues: { r: '401' } }))
        .status,
    ).toBe(200);
    const both = await tech.post<JobBody>(`/api/jobs/${job.id}/answer_checklist`, {
      itemId: voltage.id,
      fieldValues: { s: ' 399 ' },
      choice: 'pass',
    });
    expect(both.status).toBe(200);
    const stored = both.data.checklist?.responses.find((response) => response.itemId === voltage.id);
    expect(stored?.fieldValues).toEqual({ r: '401', s: '399' });
    expect(stored?.choice).toBe('pass');
  },

  async 'will not complete a source checklist with a row unanswered, or a Fail without a note'() {
    const { job, tech } = await acceptedJob(context, 'service');
    expect((await start(tech, job, latheServiceChecklist.id)).status).toBe(200);
    const all = rows(latheServiceChecklist);

    const early = await tech.post(`/api/jobs/${job.id}/complete_checklist`);
    expect(early.status).toBe(422);
    expect(early.error?.violations).toHaveLength(41);
    // Rows are named as the paper numbers them.
    expect(early.error?.violations?.[0]?.message).toContain(
      '1 Check machine level, Requires levelling plate (By request only prior to visit)',
    );

    for (const item of all) {
      const answered = await tech.post(`/api/jobs/${job.id}/answer_checklist`, {
        itemId: item.id,
        choice: item.text.includes('(if fitted)') ? 'na' : 'pass',
      });
      expect(answered.status, item.text).toBe(200);
    }
    // A Fail needs a note, which is the paper's Comments column.
    const handwritten = all.find((item) => item.text === 'Changed Fanuc control battery')!;
    expect(
      (await tech.post(`/api/jobs/${job.id}/answer_checklist`, { itemId: handwritten.id, choice: 'fail' })).status,
    ).toBe(200);
    const unexplained = await tech.post(`/api/jobs/${job.id}/complete_checklist`);
    expect(unexplained.status).toBe(422);
    expect(unexplained.error?.violations?.[0]?.code).toBe('checklist_note_required');

    expect(
      (
        await tech.post(`/api/jobs/${job.id}/answer_checklist`, {
          itemId: handwritten.id,
          notes: 'Battery replaced with the customer’s spare.',
        })
      ).status,
    ).toBe(200);
    const done = await tech.post<JobBody>(`/api/jobs/${job.id}/complete_checklist`);
    expect(done.status).toBe(200);
    expect(done.data.checklist?.completedAt).not.toBeNull();
    expect(done.data.checklist?.checklistKind).toBe('service_lathe');
  },
});
