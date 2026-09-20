import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import {
  AVAILABILITY_TYPES,
  CANCELLATION_REASONS,
  JOB_STATUS_ORDER,
  TRANSFER_REASONS,
} from '@/domain';

/**
 * The schema against the domain.
 *
 * These need no database. They hold the one property that a migration cannot
 * hold on its own: that the tables still describe the domain the application
 * actually runs on. Adding a member to a closed union in `src/domain` without a
 * matching migration fails HERE, in `npm test`, rather than at 3am against a
 * row PostgreSQL refuses to accept.
 *
 * They also pin the decisions that are expressed structurally — no soft delete
 * on jobs, no foreign key from the audit trail to the job — because those are
 * exactly the kind of thing a later "tidy-up" migration would helpfully undo.
 */

/** The members of a Postgres enum, as declared. */
const enumValues = (pgEnum: { readonly enumValues: readonly string[] }): readonly string[] => [
  ...pgEnum.enumValues,
];

const columnNames = (table: Parameters<typeof getTableConfig>[0]): readonly string[] =>
  getTableConfig(table).columns.map((column) => column.name);

describe('enums mirror the domain unions', () => {
  it('job status carries every stage, including the retired one', () => {
    // JOB_STATUS_ORDER is what a person may filter by, so it deliberately
    // leaves out `submitted` — the retired Master Review stage, which nothing
    // can enter. The COLUMN must still accept it, because historical rows are
    // in it.
    for (const status of JOB_STATUS_ORDER) {
      expect(enumValues(schema.jobStatus), status).toContain(status);
    }
    expect(enumValues(schema.jobStatus)).toContain('submitted');
    expect(enumValues(schema.jobStatus)).toHaveLength(JOB_STATUS_ORDER.length + 1);
  });

  it('cancellation reasons match exactly', () => {
    expect(enumValues(schema.cancellationReason)).toEqual([...CANCELLATION_REASONS]);
  });

  it('transfer reasons match exactly', () => {
    expect(enumValues(schema.transferReason)).toEqual([...TRANSFER_REASONS]);
  });

  it('availability types match exactly', () => {
    expect(enumValues(schema.availabilityType)).toEqual([...AVAILABILITY_TYPES]);
  });

  it('roles are the three the capability matrix knows', () => {
    expect(enumValues(schema.userRole)).toEqual(['master', 'coordinator', 'technician']);
  });

  it('delivery state keeps acceptance and delivery apart', () => {
    const states = enumValues(schema.deliveryState);
    expect(states).toContain('pending_delivery');
    expect(states).toContain('delivered');
    // The whole point of the type: a provider accepting is not a customer
    // receiving, so there must be a state between the two.
    expect(states.indexOf('pending_delivery')).toBeLessThan(states.indexOf('delivered'));
  });

  it('order number expectation is three-valued, not a boolean', () => {
    // DECISION 2: Parts requires one, Installation and Service expect one and
    // may proceed past an acknowledgement, a breakdown never has one.
    expect(enumValues(schema.orderNumberExpectation)).toEqual([
      'required',
      'expected',
      'optional',
    ]);
  });
});

describe('DECISION 6 — a deleted job is gone', () => {
  it('has no soft-delete columns on jobs', () => {
    const columns = columnNames(schema.jobs);
    for (const forbidden of ['deleted_at', 'deleted_by', 'deletion_reason', 'archived_at']) {
      expect(columns, forbidden).not.toContain(forbidden);
    }
  });

  it('does not tie an audit event to the job by foreign key', () => {
    /*
     * The decision requires the audit event to SURVIVE the deletion. A foreign
     * key cannot allow that: cascade takes the evidence with the job, restrict
     * refuses the deletion, and set-null keeps the row while losing which job
     * it was about — the one thing the event exists to say.
     */
    const config = getTableConfig(schema.auditEvents);
    const jobForeignKeys = config.foreignKeys.filter((key) =>
      key.reference().columns.some((column) => column.name === 'job_id'),
    );
    expect(jobForeignKeys).toHaveLength(0);

    // Referenced by value instead, and the number too, so a deleted job's
    // events still name it in a way a person can read.
    const columns = columnNames(schema.auditEvents);
    expect(columns).toContain('job_id');
    expect(columns).toContain('job_number');
  });

  it('keeps registers archivable, which is a different rule', () => {
    // Nothing a job refers to is ever deleted: a site, contact or machine with
    // job history is withdrawn from the register and stays resolvable for ever.
    for (const table of [schema.sites, schema.contacts, schema.machines]) {
      expect(columnNames(table)).toContain('archived_at');
    }
  });
});

describe('historical records are shaped to be immutable', () => {
  /*
   * A write-once table has no `updated_at`, because there is no update. The
   * triggers in `0002_immutability.sql` are what enforce it; this asserts the
   * SHAPE agrees, so a future column addition has to be a deliberate choice
   * rather than a copied convention.
   */
  const writeOnce = [
    ['job_signatures', schema.jobSignatures],
    ['pricing_snapshots', schema.pricingSnapshots],
    ['pricing_snapshot_lines', schema.pricingSnapshotLines],
    ['final_documents', schema.finalDocuments],
    ['audit_events', schema.auditEvents],
    ['job_transfers', schema.jobTransfers],
  ] as const;

  for (const [name, table] of writeOnce) {
    it(`${name} has no updated_at`, () => {
      expect(columnNames(table)).not.toContain('updated_at');
    });
  }

  it('a job carries exactly one signature', () => {
    const unique = getTableConfig(schema.jobSignatures).indexes.filter((index) => index.config.unique);
    expect(unique.map((index) => index.config.name)).toContain('job_signatures_job_key');
  });

  it('a job carries exactly one issued document', () => {
    const unique = getTableConfig(schema.finalDocuments).indexes.filter((index) => index.config.unique);
    expect(unique.map((index) => index.config.name)).toContain('final_documents_job_key');
  });

  it('refusals are numbered per job, so attempt 1 cannot be overwritten', () => {
    const unique = getTableConfig(schema.signatureRefusals).indexes.filter(
      (index) => index.config.unique,
    );
    expect(unique.map((index) => index.config.name)).toContain(
      'signature_refusals_job_attempt_key',
    );
    expect(columnNames(schema.signatureRefusals)).toContain('attempt');
  });

  it('a refusal keeps who recorded it, when, and why — and the resolution separately', () => {
    const columns = columnNames(schema.signatureRefusals);
    for (const required of [
      'reason',
      'recorded_by',
      'recorded_at',
      'resolved_by',
      'resolved_at',
      'resolution',
      'resolution_note',
    ]) {
      expect(columns, required).toContain(required);
    }
  });

  it('there is no "signature refused" job status', () => {
    // A refusal is an exception attached to Customer Signature, not a seventh
    // stage. The six-stage model is unchanged.
    for (const value of enumValues(schema.jobStatus)) {
      expect(value).not.toMatch(/refus/i);
    }
  });
});

describe('pricing is frozen, in cents, with its lines', () => {
  it('copies the rates rather than referencing the settings row', () => {
    const columns = columnNames(schema.pricingSnapshots);
    for (const rate of [
      'labour_normal_cents',
      'labour_overtime_cents',
      'labour_double_cents',
      'callout_rate_cents',
      'kilometre_rate_cents',
      'vat_percent_basis_points',
    ]) {
      expect(columns, rate).toContain(rate);
    }
    // A settings id would not be enough: the settings row is mutable, so a
    // later rate change would silently re-price a signed job card.
    expect(columns).not.toContain('settings_id');
  });

  it('materialises the lines the customer signed for', () => {
    const columns = columnNames(schema.pricingSnapshotLines);
    for (const required of ['quantity', 'unit_price_cents', 'line_total_cents']) {
      expect(columns, required).toContain(required);
    }
  });

  it('holds every monetary value as integer cents', () => {
    const moneyTables = [
      schema.pricingSnapshots,
      schema.pricingSnapshotLines,
      schema.jobParts,
      schema.systemSettings,
    ];
    for (const table of moneyTables) {
      for (const column of getTableConfig(table).columns) {
        if (!column.name.endsWith('_cents')) continue;
        // bigint, never numeric and never a float: currency arithmetic in
        // floating point is a production bug waiting to happen.
        expect(column.getSQLType(), `${column.name}`).toBe('bigint');
      }
    }
  });
});

describe('checklist versioning', () => {
  it('binds a completed instance to the exact version it answered', () => {
    const config = getTableConfig(schema.checklistInstances);
    const versionFk = config.foreignKeys.find((key) =>
      key.reference().columns.some((column) => column.name === 'version_id'),
    );
    // A real foreign key, which is the production form of "resolve by stored
    // version": rendering an old job card against a newer revision becomes
    // impossible rather than merely avoided.
    expect(versionFk).toBeDefined();
  });

  it('keeps a measurement range on the question', () => {
    const columns = columnNames(schema.checklistQuestions);
    expect(columns).toContain('expected_min');
    expect(columns).toContain('expected_max');
    expect(columns).toContain('response_type');
  });

  it('allows one current version per checklist', () => {
    const unique = getTableConfig(schema.checklistVersions).indexes.filter(
      (index) => index.config.unique,
    );
    expect(unique.map((index) => index.config.name)).toContain('checklist_versions_one_current');
  });
});

describe('DECISION 5 — technician visibility needs participation history', () => {
  it('records participation as its own table', () => {
    const columns = columnNames(schema.jobParticipants);
    for (const required of ['job_id', 'user_id', 'role', 'since', 'until']) {
      expect(columns, required).toContain(required);
    }
  });

  it('indexes it by the technician, which is how visibility is asked', () => {
    const names = getTableConfig(schema.jobParticipants).indexes.map((index) => index.config.name);
    expect(names).toContain('job_participants_user_idx');
  });

  it('is separate from the current assignment, which a transfer destroys', () => {
    // `job_technicians` is who is on it now; `job_participants` is who has ever
    // been. Deriving history from the first is what loses a technician access
    // to their own work the moment a job is reassigned.
    expect(columnNames(schema.jobTechnicians)).not.toContain('until');
  });
});

describe('concurrency and identity', () => {
  it('gives every mutable aggregate a version', () => {
    const mutable = [
      schema.jobs,
      schema.customers,
      schema.sites,
      schema.contacts,
      schema.machines,
      schema.availability,
      schema.users,
      schema.systemSettings,
      schema.checklistInstances,
    ];
    for (const table of mutable) {
      expect(columnNames(table), getTableConfig(table).name).toContain('version');
    }
  });

  it('makes the job number unique', () => {
    const unique = getTableConfig(schema.jobs).indexes.filter((index) => index.config.unique);
    const names = unique.map((index) => index.config.name);
    expect(names).toContain('jobs_job_number_key');
    expect(names).toContain('jobs_job_number_seq_key');
  });

  it('does not keep a mutable next-number counter', () => {
    // Allocation is a PostgreSQL sequence. A counter in a mutable row hands the
    // same value to two people raising a job at the same moment.
    expect(columnNames(schema.systemSettings)).not.toContain('next_job_sequence');
  });

  it('stores every timestamp with its timezone', () => {
    for (const table of [schema.jobs, schema.auditEvents, schema.jobSignatures]) {
      for (const column of getTableConfig(table).columns) {
        if (!/_at$/.test(column.name)) continue;
        expect(column.getSQLType(), `${column.name}`).toContain('with time zone');
      }
    }
  });
});

describe('the indexes the application actually queries by', () => {
  const indexNames = (table: Parameters<typeof getTableConfig>[0]): readonly string[] =>
    getTableConfig(table).indexes.map((index) => index.config.name ?? '');

  it('covers the job lists and the calendar', () => {
    const names = indexNames(schema.jobs);
    for (const required of [
      'jobs_status_idx',
      'jobs_primary_technician_idx',
      'jobs_customer_idx',
      'jobs_machine_idx',
      'jobs_scheduled_idx',
      'jobs_closed_at_idx',
      'jobs_open_pool_idx',
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it('covers machine lookup by both numbers', () => {
    const names = indexNames(schema.machines);
    expect(names).toContain('machines_serial_idx');
    expect(names).toContain('machines_machine_number_idx');
  });

  it('covers the availability conflict check', () => {
    expect(indexNames(schema.availability)).toContain('availability_user_window_idx');
  });

  it('covers unread notifications', () => {
    expect(indexNames(schema.notifications)).toContain('notifications_unread_idx');
  });

  it('covers the audit trail by entity, actor, type and time', () => {
    const names = indexNames(schema.auditEvents);
    for (const required of [
      'audit_events_occurred_at_idx',
      'audit_events_actor_idx',
      'audit_events_type_idx',
      'audit_events_entity_idx',
    ]) {
      expect(names, required).toContain(required);
    }
  });
});

describe('chat, notifications and audit stay separate', () => {
  it('keeps three tables, not one', () => {
    expect(getTableConfig(schema.chatMessages).name).toBe('chat_messages');
    expect(getTableConfig(schema.notifications).name).toBe('notifications');
    expect(getTableConfig(schema.auditEvents).name).toBe('audit_events');
    expect(getTableConfig(schema.jobNotes).name).toBe('job_notes');
  });

  it('links a message to the availability record it produced, rather than merging them', () => {
    // A technician saying "I have an appointment" is a MESSAGE. The record the
    // office creates from it is authoritative and separate.
    expect(columnNames(schema.chatMessages)).toContain('availability_record_id');
  });
});
