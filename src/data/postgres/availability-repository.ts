import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { asUserId, type AvailabilityRecord, type UserId } from '@/domain';
import type { AvailabilityRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { VersionLedger, requireWritten } from './versions';

type AvailabilityRow = typeof schema.availability.$inferSelect;

/**
 * `time` comes back as `HH:MM:SS`; the domain speaks `HH:MM`.
 *
 * Trimmed rather than reformatted, so a value the database rounded or padded is
 * never quietly turned into a different time.
 */
const toDomainTime = (value: string | null): string | null =>
  value === null ? null : value.slice(0, 5);

const toDomainRecord = (row: AvailabilityRow): AvailabilityRecord => ({
  id: row.id,
  userId: asUserId(row.userId),
  type: row.type,
  startDate: row.startDate,
  endDate: row.endDate,
  allDay: row.allDay,
  startTime: row.allDay ? null : toDomainTime(row.startTime),
  endTime: row.allDay ? null : toDomainTime(row.endTime),
  description: row.description,
  status: row.status,
  createdBy: asUserId(row.createdBy ?? ''),
  createdAt: row.createdAt,
  cancelledBy: row.cancelledBy === null ? null : asUserId(row.cancelledBy),
  cancelledAt: row.cancelledAt,
});

/**
 * Technician unavailability, in PostgreSQL.
 *
 * Records of ABSENCE rather than a presence calendar: a technician is available
 * unless something says otherwise. Only the office creates one — a technician
 * telling the office about an appointment is a chat message, and lives in the
 * chat tables, linked to the record the office made from it rather than
 * conflated with it.
 *
 * CANCELLING IS A STATUS CHANGE, NEVER A REMOVAL. There is no delete method,
 * because the audit trail has to be able to say what was cancelled, by whom and
 * when, and a removed row cannot be audited.
 */
export class PostgresAvailabilityRepository implements AvailabilityRepository {
  private readonly versions = new VersionLedger();

  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * Everything OVERLAPPING the window, not everything contained by it.
   *
   * A block that started last week and ends on Wednesday still makes somebody
   * unavailable on Tuesday, and a containment query would miss it — which is
   * how a double booking gets made.
   */
  async list(from?: string, to?: string): Promise<readonly AvailabilityRecord[]> {
    const overlapping =
      from === undefined || to === undefined
        ? undefined
        : and(lte(schema.availability.startDate, to), gte(schema.availability.endDate, from));

    const rows = await this.db
      .select()
      .from(schema.availability)
      .where(overlapping)
      .orderBy(asc(schema.availability.startDate));
    this.versions.rememberAll(rows);
    return rows.map(toDomainRecord);
  }

  async listForUser(userId: UserId): Promise<readonly AvailabilityRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.availability)
      .where(eq(schema.availability.userId, userId))
      .orderBy(asc(schema.availability.startDate));
    this.versions.rememberAll(rows);
    return rows.map(toDomainRecord);
  }

  async findById(id: string): Promise<AvailabilityRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.availability)
      .where(eq(schema.availability.id, id))
      .limit(1);
    this.versions.rememberAll(rows);
    return rows[0] === undefined ? null : toDomainRecord(rows[0]);
  }

  async save(record: AvailabilityRecord): Promise<AvailabilityRecord> {
    const values = {
      userId: record.userId as string,
      type: record.type,
      status: record.status,
      startDate: record.startDate,
      endDate: record.endDate,
      allDay: record.allDay,
      // Null when it is an all-day absence: the CHECK requires both times or
      // neither, and half a window is not a thing the calendar can render.
      startTime: record.allDay ? null : record.startTime,
      endTime: record.allDay ? null : record.endTime,
      description: record.description,
      cancelledBy: record.cancelledBy,
      cancelledAt: record.cancelledAt,
    } as const;

    const existing = await this.db
      .select({ version: schema.availability.version })
      .from(schema.availability)
      .where(eq(schema.availability.id, record.id))
      .limit(1);

    const current = existing[0];
    if (current === undefined) {
      const inserted = await this.db
        .insert(schema.availability)
        .values({
          id: record.id,
          ...values,
          createdBy: record.createdBy,
          createdAt: record.createdAt,
        })
        .returning();
      this.versions.rememberAll(inserted);
      return toDomainRecord(inserted[0]!);
    }

    const expected = this.versions.expected(record.id, current.version);
    const updated = await this.db
      .update(schema.availability)
      .set({ ...values, updatedAt: sql`now()`, version: expected + 1 })
      .where(
        and(
          eq(schema.availability.id, record.id),
          eq(schema.availability.version, expected),
        ),
      )
      .returning();

    const written = requireWritten(updated, 'Availability record', record.id, expected);
    this.versions.remember(written.id, written.version);
    return toDomainRecord(written);
  }
}
