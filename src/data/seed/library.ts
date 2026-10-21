import { asDocumentId, asUserId, type TechnicalDocument } from '@/domain';
import { timeOffset } from './reference';

/**
 * THE DEMONSTRATION LIBRARY. EVERY RECORD HERE IS METADATA ALONE.
 * October mandate §1.
 *
 * None of these documents exists as a file and none ever did: a seed cannot
 * ship a 200-page machine manual, and manufacturers' manuals are not EJE's to
 * redistribute. So each one is `provenance: 'simulated'` and carries NO SIZE
 * AND NO PAGE COUNT.
 *
 * WHAT THOSE TWO ZEROES REPLACE. This file used to assert `fileSizeBytes:
 * 18_442_000` and `pageCount: 214` — numbers somebody made up — and the library
 * screen printed them beside a download button for bytes that were not there.
 * A size is now measured off a real file or it is zero, and zero is what makes
 * the screen say there is nothing to open.
 *
 * A REAL revision uploaded against one of these records is genuine and says so
 * on its own row; see `library_document_versions.provenance`.
 */

export const seedDocuments: readonly TechnicalDocument[] = [
  {
    id: asDocumentId('doc-lw-v40-manual'),
    name: 'Leadwell V-40 Machine Manual',
    description:
      'Complete operator and maintenance manual for the Leadwell V-40 vertical machining centre, including alarm code reference.',
    documentType: 'machine_manual',
    manufacturer: 'Leadwell',
    machineModel: 'V-40',
    version: 'Rev 4',
    status: 'current',
    fileName: 'leadwell-v40-machine-manual-rev4.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/leadwell-v40-machine-manual-rev4.pdf',
    uploadedAt: timeOffset(-410, 9, 20),
    uploadedBy: asUserId('user-master-johan'),
    tags: ['Leadwell', 'Milling', 'Fanuc', 'Alarms'],
  },
  {
    id: asDocumentId('doc-lw-v40-electrical'),
    name: 'Leadwell V-40 Electrical Diagram',
    description:
      'Full electrical schematic set: supply, drives, spindle, I/O allocation and safety circuit.',
    documentType: 'electrical_diagram',
    manufacturer: 'Leadwell',
    machineModel: 'V-40',
    version: 'Rev 2',
    status: 'current',
    fileName: 'leadwell-v40-electrical-rev2.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/leadwell-v40-electrical-rev2.pdf',
    uploadedAt: timeOffset(-395, 14, 5),
    uploadedBy: asUserId('user-master-johan'),
    tags: ['Leadwell', 'Schematic', 'Safety Circuit'],
  },
  {
    id: asDocumentId('doc-haas-st20-service'),
    name: 'Haas ST-20 Service Manual',
    description:
      'Service procedures for the Haas ST-20 turning centre covering turret, tailstock, chuck and coolant systems.',
    documentType: 'service_manual',
    manufacturer: 'Haas',
    machineModel: 'ST-20',
    version: 'Rev 7',
    status: 'current',
    fileName: 'haas-st20-service-manual-rev7.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/haas-st20-service-manual-rev7.pdf',
    uploadedAt: timeOffset(-260, 11),
    uploadedBy: asUserId('user-master-denise'),
    tags: ['Haas', 'Turning', 'Service'],
  },
  {
    id: asDocumentId('doc-safety-general'),
    name: 'General Safety Procedure',
    description:
      'EJE standard safety procedure for work on customer sites: PPE, isolation, lock-out/tag-out and incident reporting.',
    documentType: 'safety_procedure',
    manufacturer: 'EJE Industrial Electronics',
    machineModel: 'All',
    version: 'v3.1',
    status: 'current',
    fileName: 'eje-general-safety-procedure-v3-1.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/eje-general-safety-procedure-v3-1.pdf',
    uploadedAt: timeOffset(-120, 8, 30),
    uploadedBy: asUserId('user-master-johan'),
    tags: ['Safety', 'LOTO', 'Mandatory'],
  },
  {
    id: asDocumentId('doc-proc-installation'),
    name: 'Installation Procedure',
    description:
      'Standard EJE machine installation and commissioning procedure, aligned to the installation checklist.',
    documentType: 'work_procedure',
    manufacturer: 'EJE Industrial Electronics',
    machineModel: 'All',
    version: 'v2.4',
    status: 'current',
    fileName: 'eje-installation-procedure-v2-4.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/eje-installation-procedure-v2-4.pdf',
    uploadedAt: timeOffset(-98, 15, 45),
    uploadedBy: asUserId('user-master-denise'),
    tags: ['Installation', 'Commissioning', 'Procedure'],
  },
  {
    id: asDocumentId('doc-proc-service'),
    name: 'Service Procedure',
    description:
      'Standard preventative service procedure including consumable schedule and sign-off requirements.',
    documentType: 'work_procedure',
    manufacturer: 'EJE Industrial Electronics',
    machineModel: 'All',
    version: 'v2.0',
    status: 'current',
    fileName: 'eje-service-procedure-v2-0.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/eje-service-procedure-v2-0.pdf',
    uploadedAt: timeOffset(-75, 10, 10),
    uploadedBy: asUserId('user-master-denise'),
    tags: ['Service', 'Maintenance', 'Procedure'],
  },
  {
    id: asDocumentId('doc-proc-service-old'),
    name: 'Service Procedure',
    description: 'Superseded by v2.0. Retained for reference on historical job cards.',
    documentType: 'work_procedure',
    manufacturer: 'EJE Industrial Electronics',
    machineModel: 'All',
    version: 'v1.6',
    status: 'archived',
    fileName: 'eje-service-procedure-v1-6.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/eje-service-procedure-v1-6.pdf',
    uploadedAt: timeOffset(-520, 9),
    uploadedBy: asUserId('user-master-johan'),
    tags: ['Service', 'Superseded'],
  },
  {
    id: asDocumentId('doc-fanuc-alarms'),
    name: 'Fanuc 0i-MF Alarm Code Reference',
    description: 'Quick reference for Fanuc 0i-MF servo, spindle and PMC alarm codes.',
    documentType: 'datasheet',
    manufacturer: 'Fanuc',
    machineModel: '0i-MF',
    version: 'Rev 1',
    status: 'current',
    fileName: 'fanuc-0i-mf-alarm-reference.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/fanuc-0i-mf-alarm-reference.pdf',
    uploadedAt: timeOffset(-180, 13),
    uploadedBy: asUserId('user-tech-sipho'),
    tags: ['Fanuc', 'Alarms', 'Reference'],
  },
  {
    id: asDocumentId('doc-amada-hfe'),
    name: 'Amada HFE-1303 Light Curtain Datasheet',
    description: 'Safety light curtain specification and alignment procedure.',
    documentType: 'datasheet',
    manufacturer: 'Amada',
    machineModel: 'HFE-1303',
    version: 'Rev 3',
    status: 'pending_approval',
    fileName: 'amada-hfe1303-light-curtain.pdf',
    fileSizeBytes: 0,
    /* No bytes exist, so nothing has been measured. Mandate §1.2. */
    checksumSha256: null,
    pageCount: 0,
    provenance: 'simulated',
    storageKey: 'library/amada-hfe1303-light-curtain.pdf',
    uploadedAt: timeOffset(-4, 16, 20),
    uploadedBy: asUserId('user-tech-lerato'),
    tags: ['Amada', 'Safety', 'Press Brake'],
  },
];
