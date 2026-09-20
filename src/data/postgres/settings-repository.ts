import { eq, sql } from 'drizzle-orm';
import type { SystemSettings } from '@/domain';
import type { SettingsRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { vatBasisPointsFromPercent, vatPercentFromBasisPoints } from './job-mapper';

type SettingsRow = typeof schema.systemSettings.$inferSelect;

const SINGLE_ROW_ID = 1;

/**
 * Company and commercial settings, in PostgreSQL.
 *
 * One row, enforced by a CHECK. The interesting part is what is NOT stored.
 *
 * `nextJobSequence` HAS NO COLUMN. A counter in a mutable row cannot allocate a
 * job number safely — two Masters raising a job in the same moment both read
 * the same value and both get the same number — so allocation is a PostgreSQL
 * sequence and `JobRepository.allocateJobNumber` is what consumes it. This
 * repository REPORTS the next number the sequence would hand out, so the admin
 * screen and the new-job screen keep showing it, and deliberately ignores the
 * field on the way back in: a settings write must never be able to move the
 * allocator, forwards or backwards.
 */
export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async get(): Promise<SystemSettings> {
    const rows = await this.db
      .select()
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.id, SINGLE_ROW_ID))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        'There is no system_settings row. Rates, VAT and the company details are business data, ' +
          'not reference data, so nothing invents them — capture them before raising a job.',
      );
    }
    return this.toDomain(row, await this.nextJobSequence());
  }

  async save(settings: SystemSettings): Promise<SystemSettings> {
    const values = {
      id: SINGLE_ROW_ID,
      companyName: settings.companyName,
      companyRegistration: settings.companyRegistration,
      companyVatNumber: settings.companyVatNumber,
      companyPhone: settings.companyPhone,
      companyEmail: settings.companyEmail,
      companyAddress: settings.companyAddress,
      labourNormalCents: settings.labourRates.normal,
      labourOvertimeCents: settings.labourRates.overtime,
      labourDoubleCents: settings.labourRates.double,
      calloutRateCents: settings.calloutRate,
      kilometreRateCents: settings.kilometreRate,
      vatPercentBasisPoints: vatBasisPointsFromPercent(settings.vatPercentage),
      jobNumberPrefix: settings.jobNumberPrefix,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
    } as const;

    const written = await this.db
      .insert(schema.systemSettings)
      .values(values)
      .onConflictDoUpdate({
        target: schema.systemSettings.id,
        set: {
          ...values,
          updatedAt: sql`now()`,
          version: sql`${schema.systemSettings.version} + 1`,
        },
      })
      .returning();

    return this.toDomain(written[0]!, await this.nextJobSequence());
  }

  /* ---------------------------------------------------------------------- */

  /**
   * The number `allocate_job_number()` would hand out next.
   *
   * Read from the sequence rather than stored, so it cannot disagree with the
   * allocator. `is_called` is false until the first `nextval`, at which point
   * `last_value` IS the next number rather than the last one used — which is
   * the difference between EJE-1068 and EJE-1069 on the first job ever raised.
   */
  private async nextJobSequence(): Promise<number> {
    const result = await this.db.execute<{ last_value: string; is_called: boolean }>(
      sql`select last_value, is_called from eje_job_number_seq`,
    );
    const row = [...result][0];
    if (row === undefined) {
      throw new Error('eje_job_number_seq is missing; migration 0001 has not run.');
    }
    return Number(row.last_value) + (row.is_called ? 1 : 0);
  }

  private toDomain(row: SettingsRow, nextJobSequence: number): SystemSettings {
    return {
      companyName: row.companyName,
      companyRegistration: row.companyRegistration,
      companyVatNumber: row.companyVatNumber,
      companyPhone: row.companyPhone,
      companyEmail: row.companyEmail,
      companyAddress: row.companyAddress,
      labourRates: {
        normal: row.labourNormalCents,
        overtime: row.labourOvertimeCents,
        double: row.labourDoubleCents,
      },
      calloutRate: row.calloutRateCents,
      kilometreRate: row.kilometreRateCents,
      vatPercentage: vatPercentFromBasisPoints(row.vatPercentBasisPoints),
      jobNumberPrefix: row.jobNumberPrefix,
      nextJobSequence,
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
    };
  }
}
