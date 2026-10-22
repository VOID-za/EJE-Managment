import {
  approvalForNewMachine,
  asAttachmentId,
  asMachineId,
  can,
  findSerialClash,
  isJobTechnician,
  machineDisplayName,
  userFullName,
  type Attachment,
  type CustomerId,
  type Job,
  type JobId,
  type Machine,
  type MachineType,
  type SiteId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit, notifyMasters } from './audit';
import { WorkflowError } from './errors';
import { businessToday } from '@/lib/business-time';
import { storeAndMeasure } from './stored-file';
import type { RemovalResult } from './removal';

/**
 * Machine register operations.
 *
 * A technician who finds an unrecorded machine on site can add it and carry on
 * working: the machine is usable immediately but marked unconfirmed until a
 * Master approves it onto the official register. Duplicate serial numbers are
 * refused for everyone — two records for one physical asset would split its
 * history.
 */
export interface NewMachineInput {
  readonly customerId: CustomerId;
  readonly siteId: SiteId;
  readonly manufacturer: string;
  readonly model: string;
  readonly serialNumber: string;
  /** The customer's own number for the machine. Optional — most have none. */
  readonly machineNumber: string;
  readonly machineType: MachineType;
  readonly year: number;
  readonly installationDate: string;
  readonly controlSystem: string;
  readonly notes: string;
  /**
   * Photographs of the machine as found.
   *
   * *Amended for MACH-PHOTO-1.* This used to take a file name, a caption and a
   * size the client made up, and `createMachine` called
   * `storage.put(fileName, 'image/jpeg', null)` on each one — a storage key
   * with nothing behind it. The register showed photographs that did not exist.
   *
   * The field is kept so a caller may still raise a machine with no
   * photographs, and it now carries BYTES. A machine is created first and its
   * photographs are uploaded to it afterwards, through
   * `POST /api/machines/:machineId/photos`, because a multipart create carrying
   * a machine record and several megabytes of images is a worse shape than two
   * requests that each do one thing.
   */
  readonly photos?: readonly MachinePhotoInput[];
}

export interface MachinePhotoInput {
  readonly fileName: string;
  readonly caption: string;
  /** What the server SNIFFED the bytes to be, never the browser's claim. */
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

const required = (value: string, code: string, message: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new WorkflowError(message, [{ code, message }]);
  return trimmed;
};

const assertSerialFree = async (
  context: OperationContext,
  serialNumber: string,
  excludingId?: string,
): Promise<void> => {
  // Archived machines are included: a serial number identifies one physical
  // asset, and re-adding a withdrawn machine under the same serial would split
  // its history exactly as a duplicate would.
  const machines = await context.repos.machines.list({ includeArchived: true });
  const clash = findSerialClash(machines, serialNumber, excludingId);
  if (clash === null) return;

  throw new WorkflowError(`Serial number ${clash.serialNumber} is already on the register.`, [
    {
      code: 'duplicate_serial',
      message: `It belongs to the ${machineDisplayName(clash)} already recorded against this customer.`,
    },
  ]);
};

/**
 * A MACHINE STANDS AT ONE OF ITS OWN CUSTOMER'S SITES, AND IT IS CHECKED HERE.
 * MACH-1, and a defect fix.
 *
 * `createMachine` and `updateMachine` both took `customerId` and `siteId`
 * straight from the request. The database's foreign keys refuse ids that do not
 * exist and have nothing to say about the pair being WRONG — so a machine could
 * be recorded against ABC Engineering standing at a site belonging to Jia
 * Industrial, or at a site that was withdrawn from the register last year, and
 * every job raised on it afterwards would inherit that. Job creation has
 * refused exactly this since it was written (`resolveRegister`); the register
 * that feeds it did not.
 *
 * WHAT IT REFUSES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 *   - A customer that is not on the register: refused, both on create and on
 *     amend.
 *   - A WITHDRAWN customer: refused on CREATE only, the same rule job creation
 *     applies — no new machine for an account EJE no longer trades with — while
 *     an existing machine's record stays correctable, because tidying history
 *     is not trading.
 *   - A site that is not on the register, or belongs to somebody else: refused
 *     always. This is the pair that cannot be true.
 *   - An ARCHIVED site: refused when the machine is being MOVED onto it, and
 *     allowed when the machine is already there — otherwise archiving a site
 *     would make every machine on it uneditable, which is the opposite of what
 *     withdrawing a site is for.
 *
 * IT DECIDES NOTHING ABOUT RELOCATION. Whether a machine may move between
 * customers at all, and what that means for the jobs already done on it, is
 * MACH-HIST and is open (#28). This only insists that whatever the register
 * says is internally consistent: a site that belongs to the customer the
 * machine is recorded against.
 */
const assertSiteBelongsToCustomer = async (
  context: OperationContext,
  customerId: CustomerId,
  siteId: SiteId,
  options: { readonly isNew: boolean; readonly unchangedSite: boolean },
): Promise<void> => {
  const customer = await context.repos.customers.findById(customerId);
  if (customer === null) {
    throw new WorkflowError('That customer is not on the register.', [
      {
        code: 'unknown_customer',
        message: 'A machine is recorded against a customer EJE actually has.',
      },
    ]);
  }
  if (options.isNew && !customer.active) {
    throw new WorkflowError(`${customer.name} is not an active account.`, [
      {
        code: 'customer_inactive',
        message: 'A machine cannot be added to a withdrawn customer account.',
      },
    ]);
  }

  const sites = await context.repos.customers.listSites(customerId, { includeArchived: true });
  const site = sites.find((candidate) => candidate.id === siteId);
  if (site === undefined) {
    /*
     * Deliberately one refusal for "no such site" and "somebody else's site".
     * Telling them apart would answer, for any id, whether it exists — and the
     * office screen offers only this customer's sites, so the distinction is
     * of no use to anybody legitimate.
     */
    throw new WorkflowError(`That site is not one of ${customer.name}’s.`, [
      {
        code: 'site_not_of_customer',
        message: 'A machine stands at a site belonging to the customer it is recorded against.',
      },
    ]);
  }
  if (site.archivedAt !== null && !options.unchangedSite) {
    throw new WorkflowError(`${site.name} has been withdrawn from the register.`, [
      {
        code: 'site_archived',
        message: 'Choose a site that is still on the register, or put the site back first.',
      },
    ]);
  }
};

export const createMachine = async (
  context: OperationContext,
  input: NewMachineInput,
): Promise<Machine> => {
  const serialNumber = required(
    input.serialNumber,
    'serial_required',
    'A serial number is required: it is how a machine is identified across jobs.',
  );
  await assertSerialFree(context, serialNumber);
  await assertSiteBelongsToCustomer(context, input.customerId, input.siteId, {
    isNew: true,
    unchangedSite: false,
  });

  const approval = approvalForNewMachine(context.actor.role);
  const now = context.services.clock.now();

  const photos: Attachment[] = [];
  for (const photo of input.photos ?? []) {
    // Bytes first, record second — the order every upload in this system uses,
    // so a machine cannot claim a photograph that was never written. The size
    // and the checksum are the store's own measurements of what came back.
    const stored = await storeAndMeasure(context, photo, 'That photograph could not be stored.');
    photos.push({
      id: asAttachmentId(context.services.ids.next('att')),
      kind: 'photo',
      // A machine register photograph, not job media. See MEDIA-1.
      visibility: 'customer_facing',
      fileName: photo.fileName,
      caption: photo.caption,
      storageKey: stored.storageKey,
      uploadedAt: context.services.clock.now(),
      uploadedBy: context.actor.id,
      sizeBytes: stored.sizeBytes,
      checksumSha256: stored.checksumSha256,
      // A photograph somebody really took of a real machine.
      provenance: 'genuine',
    });
  }

  const machine: Machine = {
    id: asMachineId(context.services.ids.next('machine')),
    customerId: input.customerId,
    siteId: input.siteId,
    manufacturer: required(input.manufacturer, 'manufacturer_required', 'A manufacturer is required.'),
    model: required(input.model, 'model_required', 'A model is required.'),
    serialNumber,
    machineNumber: input.machineNumber.trim(),
    machineType: input.machineType,
    year: input.year,
    installationDate: input.installationDate,
    controlSystem: input.controlSystem.trim(),
    notes: input.notes.trim(),
    photos,
    active: true,
    approval,
    createdBy: context.actor.id,
    approvedBy: approval === 'approved' ? context.actor.id : null,
    approvedAt: approval === 'approved' ? now : null,
    createdAt: now,
    archivedAt: null,
  };

  const saved = await context.repos.machines.save(machine);

  await audit(context, {
    jobId: null,
    type: 'machine_created',
    summary: `Machine added: ${machineDisplayName(saved)}`,
    detail:
      `Serial ${saved.serialNumber}. ` +
      (saved.photos.length > 0
        ? `${saved.photos.length} ${saved.photos.length === 1 ? 'photograph' : 'photographs'} attached. `
        : '') +
      (approval === 'approved'
        ? 'Added directly to the official register by the office.'
        : 'Added on site and awaiting Master approval.'),
  });

  if (approval === 'pending_approval') {
    await notifyMasters(context, {
      type: 'machine_approval_request',
      title: 'Machine awaiting approval',
      body: `${userFullName(context.actor)} added ${machineDisplayName(saved)} (serial ${saved.serialNumber}) on site. Confirm it onto the register.`,
    });
  }

  return saved;
};

/**
 * A PHOTOGRAPH OF THE MACHINE, BYTES AND ALL. MACH-PHOTO-1, MACH-PHOTO-2.
 *
 * WHO MAY. *Amended 18 October 2026: EJE answered BD-14.* The register's rules
 * about CHANGING a machine are not widened by a hair; what changed is that
 * photographing one is no longer treated as changing it.
 *
 *   - the OFFICE (`machines.manage`) may attach a photograph to any machine,
 *     because they may change the official record outright;
 *   - a TECHNICIAN may attach one to a machine THEY raised that is still
 *     `pending_approval` — their own unapproved submission, which they are
 *     already allowed to raise WITH photographs;
 *   - **a TECHNICIAN may attach one to an OFFICIAL machine when it is the
 *     machine on a job of theirs that is still live.** BD-14's own words:
 *     *"where the photograph is relevant to the technician's authorized
 *     work"* — so relevance is not a claim the client makes, it is a fact the
 *     server checks. The authorising job is named in the request, must be on
 *     THIS machine, must be assigned to this actor, and must not be closed or
 *     cancelled. It is recorded on the audit line, so every photograph of an
 *     official machine can be traced to the work that justified it.
 *   - anything else is REFUSED.
 *
 * WHAT BD-14 EXPLICITLY DID NOT GRANT, and this function is where that is
 * enforced rather than hoped for: the photograph does not touch a single field
 * of the machine record, does not alter `approval`, `approvedBy`, `approvedAt`,
 * `createdBy` or `archivedAt`, and does not shorten the change-request route
 * for anything else. `updateMachine` and `approveMachine` are untouched and
 * still refuse a technician outright. A pending machine stays pending after
 * being photographed, which `evidence-persistence.db.test.ts` asserts against
 * PostgreSQL.
 */
export interface MachinePhotoAuthorisation {
  /**
   * The job that makes this photograph part of the technician's work.
   *
   * Required for a technician photographing an OFFICIAL machine and ignored
   * for the office. A job id the actor is not on, or that is not on this
   * machine, or that has left the workflow, is the same refusal as none at
   * all — the client cannot talk its way past this by sending a job number.
   */
  readonly jobId?: JobId;
}

export const addMachinePhoto = async (
  context: OperationContext,
  machine: Machine,
  photo: MachinePhotoInput,
  authorisation: MachinePhotoAuthorisation = {},
): Promise<Machine> => {
  const office = can(context.actor.role, 'machines.manage');
  /** The job that authorised a technician's photograph, for the audit line. */
  let viaJob: Job | null = null;

  if (!office) {
    const ownPending =
      machine.approval === 'pending_approval' && machine.createdBy === context.actor.id;

    if (!ownPending) {
      viaJob = await jobAuthorisingPhoto(context, machine, authorisation.jobId);
      if (viaJob === null) {
        throw new WorkflowError(
          `You can photograph ${machineDisplayName(machine)} from a job of yours that is on it.`,
          [
            {
              code: 'not_permitted',
              message:
                machine.approval === 'approved'
                  ? 'Open the job you are working on this machine and photograph it from there. Changing the machine record itself is still a change request.'
                  : 'You can photograph a machine you added yourself, or one on a job of yours.',
            },
          ],
        );
      }
    }
  }

  // Bytes first, then read back and measured. `storeAndMeasure` writes them or
  // raises, so the row below cannot exist over a file that is not there.
  const stored = await storeAndMeasure(context, photo, 'That photograph could not be stored.');

  const attachment: Attachment = {
    id: asAttachmentId(context.services.ids.next('att')),
    kind: 'photo',
    // A machine register photograph, not job media. See MEDIA-1.
    visibility: 'customer_facing',
    fileName: photo.fileName,
    caption: photo.caption,
    storageKey: stored.storageKey,
    uploadedAt: context.services.clock.now(),
    uploadedBy: context.actor.id,
    sizeBytes: stored.sizeBytes,
    checksumSha256: stored.checksumSha256,
    provenance: 'genuine',
  };

  const saved = await context.repos.machines.save({
    ...machine,
    photos: [...machine.photos, attachment],
  });

  /*
   * ON THE TRAIL, AND NAMING THE JOB THAT ALLOWED IT. BD-14.
   *
   * `machine_photographed` rather than `machine_updated`: the record did NOT
   * change, and an audit line that says it did is the same lie the old
   * simulated photographs told about the files. `audit_events.type` is a text
   * column, so this needs no migration.
   *
   * The event is written against the authorising JOB when there is one, which
   * is what makes a technician's photograph of an official machine auditable
   * as part of that work rather than as an unexplained touch of the register.
   */
  await audit(context, {
    jobId: viaJob === null ? null : viaJob.id,
    type: 'machine_photographed',
    summary: `Machine photograph added: ${machineDisplayName(saved)}`,
    detail:
      `${attachment.fileName} attached by ${userFullName(context.actor)}.` +
      (viaJob === null ? '' : ` Photographed from ${viaJob.jobNumber}.`) +
      (saved.approval === 'pending_approval' ? ' The machine is still awaiting approval.' : ''),
  });

  return saved;
};

/**
 * The job that makes a technician's photograph of this machine legitimate.
 *
 * Returns the job, or null — and null is a refusal, not a fallback. Four things
 * have to be true at once, and each one closes a specific way of getting at a
 * machine that is none of your business: the request names a job; that job
 * exists; it is on THIS machine; and this actor is on its crew. A closed or
 * cancelled job does not count, because the work it authorised is over.
 */
const jobAuthorisingPhoto = async (
  context: OperationContext,
  machine: Machine,
  jobId: JobId | undefined,
): Promise<Job | null> => {
  if (jobId === undefined) return null;
  const job = await context.repos.jobs.findById(jobId);
  if (job === null) return null;
  if (job.machineId !== machine.id) return null;
  if (!isJobTechnician(context.actor, job)) return null;
  if (job.status === 'closed' || job.status === 'cancelled') return null;
  return job;
};

export const approveMachine = async (
  context: OperationContext,
  machine: Machine,
): Promise<Machine> => {
  if (!can(context.actor.role, 'machines.manage')) {
    throw new WorkflowError('Only a Master can confirm a machine onto the register.', [
      { code: 'not_permitted', message: 'Technicians can add machines but not approve them.' },
    ]);
  }
  if (machine.approval === 'approved') return machine;

  const saved = await context.repos.machines.save({
    ...machine,
    approval: 'approved',
    approvedBy: context.actor.id,
    approvedAt: context.services.clock.now(),
  });

  await audit(context, {
    jobId: null,
    type: 'machine_approved',
    summary: `Machine confirmed: ${machineDisplayName(saved)}`,
    detail: `Serial ${saved.serialNumber} confirmed onto the official register by ${userFullName(context.actor)}.`,
  });
  return saved;
};

/**
 * Amending the official machine record, and recording a MOVE as a move.
 *
 * `movedOn` is the day the machine actually moved, which the office states
 * because it usually learns about a move after the fact — a technician arrives
 * and the machine is in the next bay. It defaults to the business day, which is
 * right for the common case of recording a move as it happens. `moveNote` is
 * free text and usually empty.
 *
 * Both are ignored unless the site or the customer actually changed. MACH-HIST.
 */
export const updateMachine = async (
  context: OperationContext,
  machine: Machine,
  movedOn?: string,
  moveNote?: string,
): Promise<Machine> => {
  if (!can(context.actor.role, 'machines.manage')) {
    throw new WorkflowError('Only a Master can change the official machine record.', [
      { code: 'not_permitted', message: 'Technicians can raise a change request instead.' },
    ]);
  }
  await assertSerialFree(context, machine.serialNumber, machine.id);

  // Read before the write, so the trail can name what actually changed rather
  // than just saying the record was touched.
  const previous = await context.repos.machines.findById(machine.id);
  await assertSiteBelongsToCustomer(context, machine.customerId, machine.siteId, {
    isNew: false,
    // Already standing there: an archived site must not make its machines
    // uneditable, which is the opposite of what withdrawing a site is for.
    unchangedSite: previous !== null && previous.siteId === machine.siteId,
  });
  const saved = await context.repos.machines.save(machine);

  /*
   * A MOVE IS RECORDED AS A MOVE. MACH-HIST.
   *
   * `machines.site_id` is the CURRENT site, so until this existed the register
   * could answer "where is it" and nothing could answer "where was it" — and a
   * job finished eighteen months ago resolved its site LIVE, which reads like a
   * record of where the work happened and is not one.
   *
   * WRITTEN ONLY WHEN SOMETHING ACTUALLY MOVED, which the table also refuses:
   * an amendment to the serial number that happens to save the same site is not
   * a movement, and recording it would fill the history with rows saying the
   * machine stayed where it was.
   *
   * THE EFFECTIVE DATE IS STATED, NOT ASSUMED, and defaults to the business day
   * — see `movedOn`. The office usually learns about a move after the fact.
   */
  if (
    previous !== null &&
    (previous.siteId !== saved.siteId || previous.customerId !== saved.customerId)
  ) {
    await context.repos.machines.saveMovement({
      id: context.services.ids.next('mov'),
      machineId: saved.id,
      fromSiteId: previous.siteId,
      fromCustomerId: previous.customerId,
      toSiteId: saved.siteId,
      toCustomerId: saved.customerId,
      effectiveOn: movedOn ?? businessToday(new Date(context.services.clock.now())),
      note: moveNote ?? '',
      recordedBy: context.actor.id,
      recordedAt: context.services.clock.now(),
    });
  }

  const changes: string[] = [];
  if (previous !== null) {
    if (previous.serialNumber !== saved.serialNumber) {
      changes.push(`serial ${previous.serialNumber} → ${saved.serialNumber}`);
    }
    if (previous.machineNumber !== saved.machineNumber) {
      changes.push(
        `machine number ${previous.machineNumber || '—'} → ${saved.machineNumber || '—'}`,
      );
    }
    if (previous.siteId !== saved.siteId) changes.push('site');
    // MACH-HIST: a sale to another customer is a different event from a move
    // between a customer's own sites, and the trail should say which.
    if (previous.customerId !== saved.customerId) changes.push('customer');
    if (previous.active !== saved.active) {
      changes.push(saved.active ? 'returned to service' : 'taken out of service');
    }
  }

  await audit(context, {
    jobId: null,
    type: 'machine_updated',
    summary: `Machine updated: ${machineDisplayName(saved)}`,
    detail:
      `Serial ${saved.serialNumber} amended by ${userFullName(context.actor)}.` +
      (changes.length > 0 ? ` Changed: ${changes.join(', ')}.` : ''),
  });
  return saved;
};

/**
 * Removes a machine from the register.
 *
 * Deleted outright when no job was ever carried out on it — a machine captured
 * against the wrong customer, or a duplicate caught before any work. Archived
 * once it has job history, because those jobs describe work on THIS machine and
 * a job card that could no longer name it would be worthless.
 */
export const removeMachine = async (
  context: OperationContext,
  machine: Machine,
): Promise<RemovalResult> => {
  if (!can(context.actor.role, 'machines.manage')) {
    throw new WorkflowError('Only the office can remove a machine from the register.', [
      {
        code: 'not_permitted',
        message: 'Technicians can add a machine they find on site, but not remove one.',
      },
    ]);
  }

  const jobs = await context.repos.jobs.list();
  const referencing = jobs.filter((job) => job.machineId === machine.id);
  const name = machineDisplayName(machine);

  if (referencing.length === 0) {
    await context.repos.machines.delete(machine.id);
    await audit(context, {
      jobId: null,
      type: 'machine_deleted',
      summary: `Machine deleted: ${name}`,
      detail: `Serial ${machine.serialNumber} removed by ${userFullName(context.actor)}. No job had ever been carried out on it.`,
    });
    return { outcome: 'deleted', message: `${name} has been deleted.` };
  }

  await context.repos.machines.save({
    ...machine,
    archivedAt: context.services.clock.now(),
  });
  await audit(context, {
    jobId: null,
    type: 'machine_archived',
    summary: `Machine archived: ${name}`,
    detail: `Serial ${machine.serialNumber} has ${referencing.length} ${referencing.length === 1 ? 'job' : 'jobs'} on record, so it is kept and withdrawn from the register rather than deleted.`,
  });
  return {
    outcome: 'archived',
    message: `${name} has been removed from the register. ${referencing.length} ${
      referencing.length === 1 ? 'job was' : 'jobs were'
    } carried out on it, so the machine is kept and that history still reads correctly.`,
  };
};
