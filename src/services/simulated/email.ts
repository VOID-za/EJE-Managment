import type { Clock, EmailMessage, EmailService, IdGenerator, OutboxEntry } from '../ports';
import type { SimulatedOutbox } from './outbox';

/**
 * Simulated Microsoft 365 email adapter.
 *
 * DEMO BEHAVIOUR: records the message in the simulated outbox and returns.
 * No network call is made and no mail is delivered.
 */
export class SimulatedEmailService implements EmailService {
  constructor(
    private readonly outbox: SimulatedOutbox,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  send(message: EmailMessage): Promise<OutboxEntry> {
    const entry: OutboxEntry = {
      id: this.ids.next('outbox'),
      channel: 'email',
      to: message.to.join(', '),
      subject: message.subject,
      body: message.body,
      attachments: (message.attachments ?? []).map((attachment) => attachment.fileName),
      createdAt: this.clock.now(),
      simulated: true,
    };
    return Promise.resolve(this.outbox.record(entry));
  }
}
