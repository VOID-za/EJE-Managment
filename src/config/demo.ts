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
    /*
     * What is simulated here is WHERE the document is produced and kept, not
     * whether it is produced.
     *
     * This entry used to say the job card was "rendered live from the job
     * record rather than a generated PDF file", which stopped being true: the
     * system writes real PDF bytes with its own writer, stores them against the
     * job at the moment it is issued, and hands back those same bytes on every
     * later download — a job card cannot be regenerated once the customer has
     * it. Claiming otherwise understated the system, which is as misleading as
     * overstating it and undermines every other entry in this list.
     */
    name: 'Job card PDF storage',
    explanation:
      'The PDF itself is real: the document is rendered to genuine PDF bytes, written once when the job card is issued, and every later view or download returns those exact bytes — it is never re-rendered. What is simulated is where the file lives. It is rendered in the browser and kept inside the demonstration snapshot rather than on a server.',
    productionPlan:
      'The same renderer running server-side, writing to VPS storage and then to S3-compatible object storage, behind the PdfService and StorageService interfaces. The document, its immutability and its bytes do not change.',
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
