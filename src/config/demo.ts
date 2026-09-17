/**
 * Demonstration-mode configuration.
 *
 * The demo must always make it obvious what is real and what is simulated. Any
 * capability listed in `SIMULATED_CAPABILITIES` is surfaced in the UI with a
 * "Simulated" marker, and the corresponding adapter records to the outbox
 * rather than contacting an external service.
 */
export const DEMO_MODE = true;

export const DEMO_BUILD_LABEL = 'Demonstration Build';

export interface SimulatedCapability {
  readonly id: string;
  readonly name: string;
  readonly explanation: string;
  readonly productionPlan: string;
}

export const SIMULATED_CAPABILITIES: readonly SimulatedCapability[] = [
  {
    id: 'email',
    name: 'Customer email delivery',
    explanation:
      'Submitting a job card records the email in the Simulated Outbox. No email is sent.',
    productionPlan: 'Microsoft 365 via the Graph API, behind the EmailService interface.',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp notifications',
    explanation:
      'A technician who accepts a job is OFFERED the site location; choosing to send it records the exact message in the Simulated Outbox. Nothing is transmitted, and nothing is sent automatically.',
    productionPlan:
      'Official WhatsApp Business Platform with approved templates, behind the WhatsAppService interface.',
  },
  {
    id: 'pdf',
    name: 'Job card PDF',
    explanation:
      'The job card preview is rendered live from the job record rather than a generated PDF file.',
    productionPlan:
      'Server-side PDF rendering from the same job model, behind the PdfService interface.',
  },
  {
    id: 'storage',
    name: 'Photo and video storage',
    explanation:
      'Attachments are recorded against the job with placeholder tiles. No files are uploaded.',
    productionPlan:
      'VPS storage initially, then S3-compatible object storage, behind the StorageService interface.',
  },
  {
    id: 'auth',
    name: 'Sign-in',
    explanation:
      'Users are chosen from a list so both roles can be demonstrated. There is no password check.',
    productionPlan: 'Session-based authentication against the users table with hashed credentials.',
  },
  {
    id: 'offline',
    name: 'Offline capture',
    explanation:
      'The demo persists to browser storage so a demonstration survives a refresh. There is no sync engine.',
    productionPlan:
      'IndexedDB, a service worker, an offline mutation queue and a synchronisation engine.',
  },
];
