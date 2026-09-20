import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  asAttachmentId,
  asCustomerId,
  asMachineId,
  asSiteId,
  asUserId,
  type Machine,
  type MachineId,
} from '@/domain';
import type { MachineRepository, RegisterFilter } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import { machineTypeCodeFor, machineTypeFromCode } from '@/db/reference-data';
import * as schema from '@/db/schema';
import { VersionLedger, requireWritten } from './versions';
import { isUuid } from './identifiers';

type MachineRow = typeof schema.machines.$inferSelect;
type PhotoRow = typeof schema.machinePhotos.$inferSelect;

/**
 * The machine register, in PostgreSQL.
 *
 * A technician on site may add a machine they find; it is usable immediately,
 * marked `pending_approval`, until a Master confirms it — so nobody is blocked
 * from capturing work against a machine that is genuinely there. That rule is
 * `machine-operations.ts`; this stores its outcome.
 *
 * ARCHIVED, NOT DELETED, once a job has named it. `machines.customer_id` and
 * `machines.site_id` are `on delete restrict` and `jobs.machine_id` likewise,
 * so a machine a job refers to cannot be removed even by a mistaken query.
 * `delete` is only ever called for a machine nothing refers to, which the
 * application establishes first.
 *
 * MACHINE TYPE is a reference row, keyed by a slug. The domain speaks in the
 * label a person reads — "CNC Milling Machine" — and a key that survives
 * somebody correcting a label's spelling is what the column holds. The mapping
 * is in `src/db/reference-data.ts` and is the only place the two meet.
 */
export class PostgresMachineRepository implements MachineRepository {
  private readonly versions = new VersionLedger();

  constructor(private readonly db: DatabaseExecutor) {}

  async list(filter?: RegisterFilter): Promise<readonly Machine[]> {
    const rows = await this.db
      .select()
      .from(schema.machines)
      .where(filter?.includeArchived === true ? undefined : isNull(schema.machines.archivedAt))
      .orderBy(asc(schema.machines.manufacturer), asc(schema.machines.model));
    return this.assemble(rows);
  }

  /** Always resolves, archived or not: a historical job card has to render. */
  async findById(id: MachineId): Promise<Machine | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, id))
      .limit(1);
    const assembled = await this.assemble(rows);
    return assembled[0] ?? null;
  }

  async save(machine: Machine): Promise<Machine> {
    const values = {
      customerId: machine.customerId as string,
      siteId: machine.siteId as string,
      manufacturer: machine.manufacturer,
      model: machine.model,
      serialNumber: machine.serialNumber,
      machineNumber: machine.machineNumber,
      machineTypeCode: machineTypeCodeFor(machine.machineType),
      year: machine.year,
      // Empty string is "not recorded" in the demo; the column is a real date
      // and says so with null rather than with a date nobody meant.
      installationDate: machine.installationDate.length === 0 ? null : machine.installationDate,
      controlSystem: machine.controlSystem,
      notes: machine.notes,
      active: machine.active,
      approval: machine.approval,
      approvedBy: machine.approvedBy,
      approvedAt: machine.approvedAt,
      archivedAt: machine.archivedAt,
    } as const;

    const existing = await this.db
      .select({ version: schema.machines.version })
      .from(schema.machines)
      .where(eq(schema.machines.id, machine.id))
      .limit(1);

    const current = existing[0];
    if (current === undefined) {
      const inserted = await this.db
        .insert(schema.machines)
        .values({
          id: machine.id,
          ...values,
          createdBy: machine.createdBy.length === 0 ? null : machine.createdBy,
          createdAt: machine.createdAt,
        })
        .returning();
      this.versions.rememberAll(inserted);
    } else {
      const expected = this.versions.expected(machine.id, current.version);
      const updated = await this.db
        .update(schema.machines)
        .set({ ...values, updatedAt: sql`now()`, version: expected + 1 })
        .where(and(eq(schema.machines.id, machine.id), eq(schema.machines.version, expected)))
        .returning();
      const written = requireWritten(
        updated,
        'Machine',
        `${machine.manufacturer} ${machine.model}`,
        expected,
      );
      this.versions.remember(written.id, written.version);
    }

    await this.writePhotos(machine);

    const saved = await this.findById(machine.id);
    if (saved === null) throw new Error(`${machine.serialNumber} vanished during save.`);
    return saved;
  }

  async delete(id: MachineId): Promise<void> {
    await this.db.delete(schema.machines).where(eq(schema.machines.id, id));
    this.versions.forget(id);
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Photos are UPSERTED, never deleted and re-inserted.
   *
   * Each row carries the storage key of a real file. Deleting and re-inserting
   * it would break the link between the machine and bytes that still exist.
   */
  private async writePhotos(machine: Machine): Promise<void> {
    for (const photo of machine.photos) {
      await this.db
        .insert(schema.machinePhotos)
        .values({
          id: photo.id as string,
          machineId: machine.id as string,
          fileName: photo.fileName,
          caption: photo.caption,
          storageKey: photo.storageKey,
          sizeBytes: photo.sizeBytes,
          uploadedAt: photo.uploadedAt,
          uploadedBy: photo.uploadedBy.length === 0 ? null : photo.uploadedBy,
        })
        .onConflictDoUpdate({
          target: schema.machinePhotos.id,
          set: { caption: photo.caption },
        });
    }
  }

  private async assemble(rows: readonly MachineRow[]): Promise<readonly Machine[]> {
    if (rows.length === 0) return [];
    this.versions.rememberAll(rows);

    const photos = await this.db
      .select()
      .from(schema.machinePhotos)
      .where(
        inArray(
          schema.machinePhotos.machineId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(schema.machinePhotos.uploadedAt));

    const photosFor = (id: string): PhotoRow[] =>
      photos.filter((photo) => photo.machineId === id);

    return rows.map((row) => ({
      id: asMachineId(row.id),
      customerId: asCustomerId(row.customerId),
      siteId: asSiteId(row.siteId),
      manufacturer: row.manufacturer,
      model: row.model,
      serialNumber: row.serialNumber,
      machineNumber: row.machineNumber,
      machineType: machineTypeFromCode(row.machineTypeCode),
      year: row.year,
      installationDate: row.installationDate ?? '',
      controlSystem: row.controlSystem,
      notes: row.notes,
      photos: photosFor(row.id).map((photo) => ({
        id: asAttachmentId(photo.id),
        kind: 'photo' as const,
        fileName: photo.fileName,
        caption: photo.caption,
        storageKey: photo.storageKey,
        uploadedAt: photo.uploadedAt,
        uploadedBy: asUserId(photo.uploadedBy ?? ''),
        sizeBytes: photo.sizeBytes,
      })),
      active: row.active,
      approval: row.approval,
      createdBy: asUserId(row.createdBy ?? ''),
      approvedBy: row.approvedBy === null ? null : asUserId(row.approvedBy),
      approvedAt: row.approvedAt,
      createdAt: row.createdAt,
      archivedAt: row.archivedAt,
    }));
  }
}
