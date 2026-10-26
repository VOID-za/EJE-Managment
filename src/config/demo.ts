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
    productionPlan:
      'Microsoft 365 via the Graph API, behind the EmailService interface. The adapter exists (GraphEmailService); a deployment that configures it sends real mail, and a production deployment that does not refuses rather than simulating.',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp notifications',
    explanation:
      'Assignment and transfer notices, and the site location a technician chooses to send, are recorded in the Simulated Outbox. Nothing is transmitted.',
    productionPlan:
      'The WhatsApp Cloud API adapter is built. It sends only the templates eje_job_assigned and eje_site_location, which must first be approved on EJE’s WhatsApp Business account; a deployment without the token queues nothing and says so.',
  },
  {
    id: 'pdf',
    /*
     * What is simulated here is WHERE the document is kept, not whether it is
     * produced or how. Amended 26 October 2026: it read "rendered in the
     * browser and kept inside the demonstration snapshot", which stopped being
     * true when the issued copy moved to the server with its photographs.
     */
    name: 'Job card PDF storage',
    explanation:
      'The PDF is real: rendered once, on the server, when the job card is issued — photographs included — and every later download returns those exact bytes. What is simulated is where the file lives: this demonstration keeps it in the server’s memory, so it is gone when the server restarts.',
    productionPlan:
      'The same renderer writing to the server’s document storage (EJE_STORAGE_DIR), which the nightly backup includes. The document, its immutability and its bytes do not change.',
  },
  {
    id: 'storage',
    name: 'Photo and video storage',
    explanation:
      'Photographs and videos are real files, checked and stored when they are uploaded — but this demonstration keeps them in the server’s memory, so they are gone when it restarts.',
    productionPlan:
      'Written to EJE_STORAGE_DIR on the server, checked against their checksum on every read, and included in the nightly backup.',
  },
  /*
   * SIGN-IN AND OFFLINE CAPTURE ARE NOT LISTED, because neither is simulated
   * any more and this list is the answer to "what here is not real". They
   * read "chosen from a list … no password check" and "there is no sync
   * engine", both untrue: sign-in is session-based with a password (the
   * demonstration accounts share one published password), and work captured
   * offline is held on the tablet and sent when the connection returns. What
   * offline does NOT yet do — a signature or refusal — is open decision BD-23.
   */
];
