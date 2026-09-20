import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { cents, createdAt, rowVersion, updatedAt } from './columns';
import { jobPriority, orderNumberExpectation } from './enums';
import { users } from './identity';

/**
 * Company and commercial settings. Exactly one row.
 *
 * `nextJobSequence` from the demo is DELIBERATELY ABSENT. A counter in a
 * mutable row cannot allocate a job number safely: two Masters raising a job at
 * the same moment both read the same value and both get the same number.
 * Allocation is a PostgreSQL sequence instead — see
 * `src/db/migrations/0001_job_numbering.sql`.
 */
export const systemSettings = pgTable(
  'system_settings',
  {
    /** Enforced single row: `id` is always 1. */
    id: smallint('id').primaryKey().default(1),

    companyName: text('company_name').notNull(),
    companyRegistration: text('company_registration').notNull().default(''),
    companyVatNumber: text('company_vat_number').notNull().default(''),
    companyPhone: text('company_phone').notNull().default(''),
    companyEmail: text('company_email').notNull().default(''),
    companyAddress: text('company_address').notNull().default(''),

    /* Charge-out rates, in cents. Frozen onto a job at signature; see pricing.ts. */
    labourNormalCents: cents('labour_normal_cents').notNull(),
    labourOvertimeCents: cents('labour_overtime_cents').notNull(),
    labourDoubleCents: cents('labour_double_cents').notNull(),
    calloutRateCents: cents('callout_rate_cents').notNull(),
    kilometreRateCents: cents('kilometre_rate_cents').notNull(),
    /**
     * VAT as hundredths of a percent: 1500 is 15%.
     *
     * An integer for the same reason money is — 15.5% must not become
     * 15.500000000000002 on a document a customer signed.
     */
    vatPercentBasisPoints: integer('vat_percent_basis_points').notNull(),

    jobNumberPrefix: text('job_number_prefix').notNull().default('EJE-'),
    quietHoursStart: text('quiet_hours_start').notNull().default('18:00'),
    quietHoursEnd: text('quiet_hours_end').notNull().default('07:00'),

    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id),
    version: rowVersion(),
  },
  (table) => [
    check('system_settings_single_row', sql`${table.id} = 1`),
    check('system_settings_rates_non_negative', sql`
      ${table.labourNormalCents} >= 0
      and ${table.labourOvertimeCents} >= 0
      and ${table.labourDoubleCents} >= 0
      and ${table.calloutRateCents} >= 0
      and ${table.kilometreRateCents} >= 0
      and ${table.vatPercentBasisPoints} >= 0
    `),
  ],
);

/**
 * Job type behaviour, as rows rather than a constant.
 *
 * `src/domain/job/job-types.ts` says exactly this: "Phase 2 replaces the
 * constant below with rows loaded from a `job_types` table; every consumer
 * reads the definition through `getJobTypeDefinition`, so nothing else
 * changes." The columns are that interface, field for field, plus DECISION 2's
 * `order_number_expectation`.
 *
 * A text primary key rather than an enum, because these are administered rows.
 */
export const jobTypes = pgTable('job_types', {
  /** `breakdown`, `installation`, `service`, `test_and_repair`, `parts`. */
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  description: text('description').notNull().default(''),

  checklistRequired: boolean('checklist_required').notNull(),
  photosRequired: boolean('photos_required').notNull(),
  schedulesDateRange: boolean('schedules_date_range').notNull(),
  capturesLabourAndTravel: boolean('captures_labour_and_travel').notNull(),
  visitsSite: boolean('visits_site').notNull(),
  /** DECISION 2: required (Parts) | expected (Installation, Service) | optional. */
  orderNumberExpectation: orderNumberExpectation('order_number_expectation').notNull(),
  capturesDeliveryNote: boolean('captures_delivery_note').notNull(),
  collectedOnCompletion: boolean('collected_on_completion').notNull(),

  defaultPriority: jobPriority('default_priority').notNull(),
  /** Design-system token name. Presentation, but it belongs with the definition. */
  accent: text('accent').notNull(),
  position: integer('position').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Machine types, as rows.
 *
 * Same reasoning and the same docblock: `types/machine.ts` says "Phase 2 moves
 * them to a `machine_types` table administered by Masters".
 */
export const machineTypes = pgTable('machine_types', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  position: integer('position').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});
