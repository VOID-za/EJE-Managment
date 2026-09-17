import type { JobPriority, JobTypeCode } from '../types/job';

/**
 * Behavioural definition of a job type.
 *
 * Business rules live here, not in components. Phase 2 replaces the constant
 * below with rows loaded from a `job_types` table; every consumer reads the
 * definition through `getJobTypeDefinition`, so nothing else changes.
 */
export interface JobTypeDefinition {
  readonly code: JobTypeCode;
  readonly label: string;
  readonly description: string;
  /** A checklist must be completed before the job can leave `completion`. */
  readonly checklistRequired: boolean;
  /** At least one job photo is required before completion. */
  readonly photosRequired: boolean;
  readonly defaultPriority: JobPriority;
  /** Tailwind-safe token name used by the design system for this job type. */
  readonly accent: 'red' | 'blue' | 'green' | 'violet';
}

const DEFINITIONS: Readonly<Record<JobTypeCode, JobTypeDefinition>> = {
  breakdown: {
    code: 'breakdown',
    label: 'Breakdown',
    description: 'Unplanned machine failure requiring a reactive site visit.',
    checklistRequired: false,
    photosRequired: false,
    defaultPriority: 'urgent',
    accent: 'red',
  },
  installation: {
    code: 'installation',
    label: 'Installation',
    description: 'Commissioning and hand-over of a machine at a customer site.',
    checklistRequired: true,
    photosRequired: true,
    defaultPriority: 'normal',
    accent: 'blue',
  },
  service: {
    code: 'service',
    label: 'Service',
    description: 'Planned preventative maintenance against the service schedule.',
    checklistRequired: true,
    photosRequired: false,
    defaultPriority: 'normal',
    accent: 'green',
  },
  test_and_repair: {
    code: 'test_and_repair',
    label: 'Test & Repair',
    description: 'Workshop or on-site testing and repair of a unit or assembly.',
    checklistRequired: false,
    photosRequired: false,
    defaultPriority: 'normal',
    accent: 'violet',
  },
};

export const JOB_TYPE_CODES: readonly JobTypeCode[] = [
  'breakdown',
  'installation',
  'service',
  'test_and_repair',
];

export const getJobTypeDefinition = (code: JobTypeCode): JobTypeDefinition => DEFINITIONS[code];

export const listJobTypeDefinitions = (): readonly JobTypeDefinition[] =>
  JOB_TYPE_CODES.map(getJobTypeDefinition);

export const jobTypeLabel = (code: JobTypeCode): string => DEFINITIONS[code].label;

export const PRIORITY_ORDER: readonly JobPriority[] = ['urgent', 'high', 'normal', 'low'];

export const priorityLabel = (priority: JobPriority): string => {
  switch (priority) {
    case 'low':
      return 'Low';
    case 'normal':
      return 'Normal';
    case 'high':
      return 'High';
    case 'urgent':
      return 'Urgent';
  }
};

export const priorityRank = (priority: JobPriority): number => PRIORITY_ORDER.indexOf(priority);
