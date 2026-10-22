import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  asProvenance,
  asAttachmentId,
  asCustomerId,
  asMachineId,
  asSiteId,
  asUserId,
  type Machine,
  type MachineDocument,
  type MachineMovement,
  type MachineDocumentAudience,
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
type MachineDocumentRow = typeof schema.machineDocuments.$inferSelect;

/**
 * An unrecognised audience reads as `office_only`, which is the safe
 * direction: a value this code does not understand must not widen who sees a
 * document. The CHECK constraint makes it unreachable through the application
 * anyway; this is what happens if somebody writes the row by hand.
 */
const toDomainAudience = (value: string): MachineDocumentAudience =>
  value === 'field' ? 'field' : 'office_only';

type MachineMovementRow = typeof schema.machineMovements.$inferSelect;

const toDomainMachineMovement = (row: MachineMovementRow): MachineMovement => ({
  id: row.id,
  machineId: asMachineId(row.machineId),
  fromSiteId: row.fromSiteId === null ? null : asSiteId(row.fromSiteId),
  fromCustomerId: row.fromCustomerId === null ? null : asCustomerId(row.fromCustomerId),
  toSiteId: asSiteId(row.toSiteId),
  toCustomerId: asCustomerId(row.toCustomerId),
  effectiveOn: row.effectiveOn,
  note: row.note,
  recordedBy: asUserId(row.recordedBy ?? ''),
  recordedAt: row.recordedAt,
});

const toDomainMachineDocument = (row: MachineDocumentRow): MachineDocument => ({
  id: row.id,
  machineId: asMachineId(row.machineId),
  fileName: row.fileName,
  caption: row.caption,
  contentType: row.contentType,
  storageKey: row.storageKey,
  sizeBytes: row.sizeBytes,
  checksumSha256: row.checksumSha256,
  audience: toDomainAudience(row.audience),
  uploadedAt: row.uploadedAt,
  uploadedBy: asUserId(row.uploadedBy ?? ''),
  provenance: asProvenance(row.provenance),
  archivedAt: row.archivedAt,
});

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

  /* -- paper about one machine. October mandate §4. ----------------------- */

  async listDocuments(
    machineId: MachineId,
    filter?: { readonly includeArchived?: boolean },
  ): Promise<readonly MachineDocument[]> {
    if (!isUuid(machineId)) return [];
    const rows = await this.db
      .select()
      .from(schema.machineDocuments)
      .where(
        filter?.includeArchived === true
          ? eq(schema.machineDocuments.machineId, machineId)
          : and(
              eq(schema.machineDocuments.machineId, machineId),
              isNull(schema.machineDocuments.archivedAt),
            ),
      )
      // Newest first: the office is looking for what was added recently.
      .orderBy(desc(schema.machineDocuments.uploadedAt));
    return rows.map(toDomainMachineDocument);
  }

  async findDocumentById(id: string): Promise<MachineDocument | null> {
    // A caller-supplied id reaches this; anything that is not a uuid would
    // make PostgreSQL raise rather than answer "no such document".
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(schema.machineDocuments)
      .where(eq(schema.machineDocuments.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toDomainMachineDocument(row);
  }

  /* -- where a machine has stood. MACH-HIST ------------------------------- */

  async listMovements(machineId: MachineId): Promise<readonly MachineMovement[]> {
    if (!isUuid(machineId)) return [];
    const rows = await this.db
      .select()
      .from(schema.machineMovements)
      .where(eq(schema.machineMovements.machineId, machineId))
      /*
       * Newest first, and `recorded_at` breaks a tie on the same day: two
       * moves stated as effective on one date are ordered by which was
       * written down second, so `machineLocationAsAt` gets the later one.
       */
      .orderBy(desc(schema.machineMovements.effectiveOn), desc(schema.machineMovements.recordedAt));
    return rows.map(toDomainMachineMovement);
  }

  async saveMovement(movement: MachineMovement): Promise<MachineMovement> {
    /*
     * INSERT ONLY. There is deliberately no conflict clause: a movement is
     * something that happened, and a save that could rewrite one would make
     * the history editable. A move recorded wrongly is corrected by recording
     * the real one.
     */
    const rows = await this.db
      .insert(schema.machineMovements)
      .values({
        id: movement.id,
        machineId: movement.machineId as string,
        fromSiteId: movement.fromSiteId,
        fromCustomerId: movement.fromCustomerId,
        toSiteId: movement.toSiteId as string,
        toCustomerId: movement.toCustomerId as string,
        effectiveOn: movement.effectiveOn,
        note: movement.note,
        recordedBy: movement.recordedBy.length === 0 ? null : (movement.recordedBy as string),
        recordedAt: movement.recordedAt,
      })
      .returning();
    /*
     * A plain insert, so a missing row is a bug rather than a lost race —
     * `requireWritten` is for a conditional UPDATE and would be the wrong
     * error here.
     */
    const row = rows[0];
    if (row === undefined) throw new Error('the machine movement was not written');
    return toDomainMachineMovement(row);
  }

  async saveDocument(document: MachineDocument): Promise<MachineDocument> {
    /*
     * INSERT, OR UPDATE THE THREE THINGS THAT MAY CHANGE.
     *
     * The file name, the bytes, the size and the checksum describe a file that
     * was stored once. What the office may revise afterwards is the caption,
     * the audience — a manual wrongly marked office-only is exactly the
     * mistake the safe default invites — and whether it is withdrawn. A
     * wholesale update would let a later save silently redescribe somebody
     * else's document.
     */
    const inserted = await this.db
      .insert(schema.machineDocuments)
      .values({
        id: document.id,
        machineId: document.machineId as string,
        fileName: document.fileName,
        caption: document.caption,
        contentType: document.contentType,
        storageKey: document.storageKey,
        sizeBytes: document.sizeBytes,
        checksumSha256: document.checksumSha256,
        audience: document.audience,
        uploadedAt: document.uploadedAt,
        uploadedBy: document.uploadedBy.length === 0 ? null : (document.uploadedBy as string),
        provenance: document.provenance,
        archivedAt: document.archivedAt,
      })
      .onConflictDoUpdate({
        target: schema.machineDocuments.id,
        set: {
          caption: document.caption,
          audience: document.audience,
          archivedAt: document.archivedAt,
        },
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new Error(`${document.fileName} vanished during save.`);
    return toDomainMachineDocument(row);
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
          // Measured by the store. The column arrived with `0021`.
          checksumSha256: photo.checksumSha256,
          uploadedAt: photo.uploadedAt,
          uploadedBy: photo.uploadedBy.length === 0 ? null : photo.uploadedBy,
          /*
           * WHOSE PHOTOGRAPH THIS IS. October mandate §1, and the second place
           * the same omission was found: the seed marked its demonstration
           * photographs `simulated`, this insert did not carry the field, and
           * the column took its `genuine` default — so the register would have
           * shown three fixtures as photographs of a customer's machines. A
           * label that does not reach the database is not a label.
           */
          provenance: photo.provenance,
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
        /*
         * A MACHINE photograph, not job media. MEDIA-1.
         *
         * `machine_photos` is a different table with no visibility column, and
         * it needs none: a machine's photographs belong to the machine register
         * the customer already sees, and they are not printed on a job card.
         * `customer_facing` is the honest value, not a placeholder.
         */
        visibility: 'customer_facing' as const,
        fileName: photo.fileName,
        caption: photo.caption,
        storageKey: photo.storageKey,
        checksumSha256: photo.checksumSha256,
        // An unrecognised value reads as `unknown` rather than as an
        // accusation either way: see `asProvenance`.
        provenance: asProvenance(photo.provenance),
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
