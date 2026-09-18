import type {
  Clock,
  DeliveryReceipt,
  EmailMessage,
  EmailService,
  IdGenerator,
  OutboxEntry,
} from '../ports';
import type { SimulatedOutbox } from './outbox';

/**
 * Simulated Microsoft 365 email adapter.
 *
 * DEMO BEHAVIOUR: records the message in the simulated outbox. No network call
 * is made and no mail is delivered.
 *
 * It therefore reports `pending_delivery` — the provider has the message and
 * nothing has confirmed the customer received it. It deliberately NEVER returns
 * `delivered` on its own: claiming delivery the demo cannot observe is exactly
 * the false success this state machine exists to prevent, and it would let a
 * job close on a lie.
 *
 * Delivery is confirmed from the Simulated Outbox screen, which stands in for
 * the delivery report Microsoft 365 sends in production. That is also how the
 * pending and failed paths are exercised.
 */
export class SimulatedEmailService implements EmailService {
  constructor(
    private readonly outbox: SimulatedOutbox,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async send(message: EmailMessage): Promise<DeliveryReceipt> {
    const to = message.to.join(', ');
    const entry: OutboxEntry = {
      id: this.ids.next('outbox'),
      channel: 'email',
      to,
      subject: message.subject,
      body: message.body,
      attachments: (message.attachments ?? []).map((attachment) => attachment.fileName),
      createdAt: this.clock.now(),
      simulated: true,
      delivery: 'pending_delivery',
      failureReason: '',
    };
    const recorded = await this.outbox.record(entry);

    // A recipient the provider would reject outright is rejected here too, so
    // the failure path is reachable without anyone pretending.
    if (!to.includes('@') || to.trim().length === 0) {
      const failed = await this.outbox.setDelivery(
        recorded.id,
        'failed',
        'The provider rejected the recipient address.',
      );
      return {
        messageId: recorded.id,
        state: 'failed',
        failureReason: 'The provider rejected the recipient address.',
        entry: failed,
      };
    }

    return {
      messageId: recorded.id,
      // Accepted. NOT delivered — nobody has confirmed the customer has it.
      state: 'pending_delivery',
      failureReason: '',
      entry: recorded,
    };
  }

  async deliveryState(messageId: string): Promise<DeliveryReceipt | null> {
    const entry = (await this.outbox.list()).find((candidate) => candidate.id === messageId);
    if (entry === undefined) return null;
    return {
      messageId: entry.id,
      state: entry.delivery,
      failureReason: entry.failureReason,
      entry,
    };
  }
}
