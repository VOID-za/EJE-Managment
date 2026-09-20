import { sql } from 'drizzle-orm';
import { JOB_TYPE_CODES, getJobTypeDefinition, type MachineType } from '@/domain';
import type { DatabaseExecutor } from './client';
import * as schema from './schema';

/**
 * Reference data: the rows the rest of the schema refers to by key.
 *
 * NOT DEMO DATA. Job types and machine types are administered reference rows,
 * and `jobs.job_type_code`, `checklists.job_type_code` and
 * `machines.machine_type_code` are foreign keys to them — an empty database
 * cannot store a single job until these exist. Customers, users and jobs are
 * business data and are deliberately not here; nothing in this file invents a
 * person, a price or a machine.
 *
 * The CONTENTS come from the domain, which is where the behaviour already
 * lives. `job-types.ts` says "Phase 2 replaces the constant below with rows
 * loaded from a `job_types` table; every consumer reads the definition through
 * `getJobTypeDefinition`, so nothing else changes" — this is the other half of
 * that sentence. Until a screen administers these rows, the domain constant is
 * the source and this projects it, so the two cannot drift.
 */

/**
 * Machine types: the domain's closed union, as administered rows.
 *
 * The union member is the LABEL a person reads. A row needs a stable key that
 * survives someone correcting the spelling of a label, so each carries a slug
 * as well. Everything above the repository keeps speaking in labels.
 */
const MACHINE_TYPE_CODES: Readonly<Record<MachineType, string>> = {
  'CNC Milling Machine': 'cnc_milling_machine',
  'CNC Lathe': 'cnc_lathe',
  'Machining Centre': 'machining_centre',
  'Surface Grinder': 'surface_grinder',
  'Press Brake': 'press_brake',
  Other: 'other',
};

export const MACHINE_TYPE_LABELS: readonly MachineType[] = Object.keys(
  MACHINE_TYPE_CODES,
) as MachineType[];

const LABEL_BY_CODE = new Map<string, MachineType>(
  MACHINE_TYPE_LABELS.map((label) => [MACHINE_TYPE_CODES[label], label]),
);

export const machineTypeCodeFor = (label: MachineType): string => MACHINE_TYPE_CODES[label];

/**
 * The label for a stored code.
 *
 * An unknown code becomes `Other` rather than throwing: a machine administered
 * into a type this build has never heard of is still a machine somebody has to
 * be able to open, and refusing to read the row would take the whole register
 * down with it.
 */
export const machineTypeFromCode = (code: string): MachineType =>
  LABEL_BY_CODE.get(code) ?? 'Other';

/** The job-type rows, projected from the domain definitions. */
export const jobTypeRows = (): readonly (typeof schema.jobTypes.$inferInsert)[] =>
  JOB_TYPE_CODES.map((code, position) => {
    const definition = getJobTypeDefinition(code);
    return {
      code: definition.code,
      label: definition.label,
      description: definition.description,
      checklistRequired: definition.checklistRequired,
      photosRequired: definition.photosRequired,
      schedulesDateRange: definition.schedulesDateRange,
      capturesLabourAndTravel: definition.capturesLabourAndTravel,
      visitsSite: definition.visitsSite,
      orderNumberExpectation: definition.orderNumberExpectation,
      capturesDeliveryNote: definition.capturesDeliveryNote,
      collectedOnCompletion: definition.collectedOnCompletion,
      defaultPriority: definition.defaultPriority,
      accent: definition.accent,
      position,
    };
  });

export const machineTypeRows = (): readonly (typeof schema.machineTypes.$inferInsert)[] =>
  MACHINE_TYPE_LABELS.map((label, position) => ({
    code: MACHINE_TYPE_CODES[label],
    label,
    position,
  }));

/**
 * Writes the reference rows, leaving anything else alone.
 *
 * Upsert rather than replace, and deliberately no DELETE: a job type nobody
 * raises any more is still named by the jobs that were raised under it, and
 * removing the row would take those jobs with it. Safe to run on every
 * deployment — it is how a new job type reaches an existing database.
 */
export const syncReferenceData = async (db: DatabaseExecutor): Promise<void> => {
  await db
    .insert(schema.jobTypes)
    .values([...jobTypeRows()])
    .onConflictDoUpdate({
      target: schema.jobTypes.code,
      set: {
        label: sql`excluded.label`,
        description: sql`excluded.description`,
        checklistRequired: sql`excluded.checklist_required`,
        photosRequired: sql`excluded.photos_required`,
        schedulesDateRange: sql`excluded.schedules_date_range`,
        capturesLabourAndTravel: sql`excluded.captures_labour_and_travel`,
        visitsSite: sql`excluded.visits_site`,
        orderNumberExpectation: sql`excluded.order_number_expectation`,
        capturesDeliveryNote: sql`excluded.captures_delivery_note`,
        collectedOnCompletion: sql`excluded.collected_on_completion`,
        defaultPriority: sql`excluded.default_priority`,
        accent: sql`excluded.accent`,
        position: sql`excluded.position`,
        updatedAt: sql`now()`,
      },
    });

  await db
    .insert(schema.machineTypes)
    .values([...machineTypeRows()])
    .onConflictDoUpdate({
      target: schema.machineTypes.code,
      set: { label: sql`excluded.label`, position: sql`excluded.position` },
    });
};
