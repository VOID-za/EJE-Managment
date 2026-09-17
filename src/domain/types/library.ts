import type { DocumentId, IsoDateTime, UserId } from './common';

export type TechnicalDocumentType =
  | 'machine_manual'
  | 'electrical_diagram'
  | 'service_manual'
  | 'safety_procedure'
  | 'work_procedure'
  | 'datasheet';

export interface TechnicalDocument {
  readonly id: DocumentId;
  readonly name: string;
  readonly description: string;
  readonly documentType: TechnicalDocumentType;
  readonly manufacturer: string;
  readonly machineModel: string;
  readonly version: string;
  readonly status: 'current' | 'archived' | 'pending_approval';
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly pageCount: number;
  readonly storageKey: string;
  readonly uploadedAt: IsoDateTime;
  readonly uploadedBy: UserId;
  readonly tags: readonly string[];
}
