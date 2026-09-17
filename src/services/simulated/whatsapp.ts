import type { Clock, IdGenerator, OutboxEntry, WhatsAppMessage, WhatsAppService } from '../ports';
import type { SimulatedOutbox } from './outbox';

/**
 * Simulated WhatsApp Business Platform adapter.
 *
 * DEMO BEHAVIOUR: records the templated message in the simulated outbox.
 * No message is transmitted. Production will submit an approved template to the
 * Cloud API and reconcile delivery receipts.
 */
export class SimulatedWhatsAppService implements WhatsAppService {
  constructor(
    private readonly outbox: SimulatedOutbox,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  send(message: WhatsAppMessage): Promise<OutboxEntry> {
    const entry: OutboxEntry = {
      id: this.ids.next('outbox'),
      channel: 'whatsapp',
      to: message.to,
      subject: `Template: ${message.templateName}`,
      body: message.preview,
      attachments: [],
      createdAt: this.clock.now(),
      simulated: true,
    };
    return Promise.resolve(this.outbox.record(entry));
  }
}
