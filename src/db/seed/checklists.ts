import { asChecklistTemplateId, type ChecklistItem, type ChecklistTemplate } from '@/domain';
import { demoId } from './ids';
import { timeAgo } from './calendar';

/**
 * ============================================================================
 * REPRESENTATIVE DEMONSTRATION CONTENT — NOT THE APPROVED EJE WORDING
 * ============================================================================
 *
 * The production system must carry the exact wording of EJE's own controlled
 * checklists. What follows is representative industrial content, written so the
 * checklist experience can be reviewed end to end. Replacing it is a DATA
 * change: transcribe the approved document into a new version, bump `version`,
 * set `sourceDocument` to the controlled document id, and archive the previous
 * one. A job that has already been completed keeps answering against the
 * version it was answered on.
 */
export const templateId = (key: string) => asChecklistTemplateId(demoId(`checklist:${key}`));

/**
 * Section and question identifiers.
 *
 * PostgreSQL keys every one of them with a `uuid`, and a completed checklist
 * stores the QUESTION id against each answer — so the readable keys used below
 * (`inst-1`, `svc-5`) are names in this file only, and are turned into the same
 * uuid on every run. That is what lets a seeded answer still point at the
 * question it answered.
 */
export const sectionId = (key: string) => demoId(`checklist-section:${key}`);
export const itemId = (key: string) => demoId(`checklist-item:${key}`);

const passFail = (
  key: string,
  text: string,
  helpText = '',
  photoRequired = false,
): ChecklistItem => ({
  id: itemId(key),
  text,
  helpText,
  responseType: 'pass_fail_na',
  required: true,
  photoRequired,
  unit: null,
  expectedRange: null,
});

const yesNo = (key: string, text: string, helpText = ''): ChecklistItem => ({
  id: itemId(key),
  text,
  helpText,
  responseType: 'yes_no',
  required: true,
  photoRequired: false,
  unit: null,
  expectedRange: null,
});

const measurement = (
  key: string,
  text: string,
  unit: string,
  min: number,
  max: number,
  helpText = '',
): ChecklistItem => ({
  id: itemId(key),
  text,
  helpText,
  responseType: 'measurement',
  required: true,
  photoRequired: false,
  unit,
  expectedRange: { min, max },
});

export const INSTALLATION_TEMPLATE_VERSION = '1.0-DEMO';
export const SERVICE_TEMPLATE_VERSION = '1.0-DEMO';

export const installationTemplate: ChecklistTemplate = {
  id: templateId('installation'),
    name: 'Machine Installation & Commissioning Checklist (DEMO)',
    description:
      'Completed on every installation before the machine is handed to the customer. Photographic evidence is required at the marked steps.',
    jobTypeCode: 'installation',
    version: INSTALLATION_TEMPLATE_VERSION,
    status: 'current',
    sourceDocument: 'DEMO CONTENT — pending replacement with the approved EJE document',
    updatedAt: timeAgo(120, 9),
    sections: [
      {
        id: sectionId('inst-sec-site'),
        title: 'Site & positioning',
        description: 'The installation environment, before the machine is energised.',
        items: [
          passFail('inst-1', 'Machine installed correctly and positioned on its marked location'),
          passFail('inst-2', 'Floor condition and load capacity confirmed suitable'),
          measurement(
            'inst-3',
            'Machine levelled — worst reading across the table',
            'µm/m',
            0,
            40,
            'Record the worst-case reading, not the best.',
          ),
        ],
      },
      {
        id: sectionId('inst-sec-electrical'),
        title: 'Electrical & safety',
        description: 'Nothing in this section may be marked N/A.',
        items: [
          passFail('inst-4', 'Electrical connections verified and torqued', '', true),
          measurement('inst-5', 'Supply voltage measured at the isolator', 'V', 380, 420),
          passFail('inst-6', 'Earth continuity verified'),
          passFail('inst-7', 'Safety guards fitted and interlocks proven'),
          passFail('inst-8', 'Emergency stop tested on every station', '', true),
        ],
      },
      {
        id: sectionId('inst-sec-handover'),
        title: 'Commissioning & hand-over',
        description: 'What the customer is left with.',
        items: [
          passFail('inst-9', 'Machine operation verified through a full test cycle'),
          yesNo('inst-10', 'Customer instructed on operation and daily checks'),
          yesNo('inst-11', 'Manuals and certificates handed to the customer'),
        ],
    },
  ],
};

export const serviceTemplate: ChecklistTemplate = {
  id: templateId('service'),
    name: 'Preventative Service Checklist (DEMO)',
    description:
      'Completed on every service. The measurement steps record what was found, not what was expected.',
    jobTypeCode: 'service',
    version: SERVICE_TEMPLATE_VERSION,
    status: 'current',
    sourceDocument: 'DEMO CONTENT — pending replacement with the approved EJE document',
    updatedAt: timeAgo(120, 9),
    sections: [
      {
        id: sectionId('svc-sec-safety'),
        title: 'Safety systems',
        description: 'Checked first, because the rest of the service runs on the machine.',
        items: [
          passFail('svc-1', 'Emergency stop tested on every station', '', true),
          passFail('svc-2', 'Safety guards and interlocks proven'),
          passFail('svc-3', 'Warning labels legible and in place'),
        ],
      },
      {
        id: sectionId('svc-sec-mechanical'),
        title: 'Mechanical',
        description: '',
        items: [
          passFail('svc-4', 'Way lube level and distribution checked'),
          measurement(
            'svc-5',
            'Electrical cabinet temperature at operating condition',
            '°C',
            10,
            40,
            'Measured after at least 30 minutes of running.',
          ),
          passFail('svc-6', 'Coolant concentration checked and corrected'),
          passFail('svc-7', 'Air pressure and filtration checked'),
        ],
      },
      {
        id: sectionId('svc-sec-control'),
        title: 'Control & hand-back',
        description: '',
        items: [
          passFail('svc-8', 'Control memory battery checked'),
          passFail('svc-9', 'Machine test run completed'),
          yesNo('svc-10', 'Machine handed back to production'),
        ],
      },
  ],
};

export const seedChecklistTemplates: readonly ChecklistTemplate[] = [
  installationTemplate,
  serviceTemplate,
];

/** Every item id in a template, so a completed checklist can answer all of them. */
export const itemIds = (template: ChecklistTemplate): readonly string[] =>
  template.sections.flatMap((section) => section.items.map((item) => item.id));
