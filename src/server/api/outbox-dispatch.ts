import 'server-only';
import type { OutboxMessage } from '@/domain';
import type { ServerRuntime } from '@/server/runtime';

/**
 * Sending what the last transaction promised to send.
 *
 * WHERE THIS RUNS: after `writeRoute`'s transaction has COMMITTED, and outside
 * any transaction of its own. That is the entire architectural point. The
 * business change and the obligation to tell somebody commit together; the
 * telling happens afterwards, where a slow provider costs latency rather than a
 * database connection.
 *
 *   validate → persist → record the obligation → COMMIT → send
 *
 * WHY IT IS NOT A JOB QUEUE. There is no scheduler, no worker and no broker.
 * Each mutation drains a few messages on its way out, which in practice means
 * the request that created the obligation is the one that discharges it, and
 * anything it could not send is picked up by the next mutation anybody makes.
 * For a business with a dozen people and a handful of assignments an hour, that
 * is the whole requirement. If EJE ever need delivery within seconds of a quiet
 * period, a timer calling this same function is the change — not a rewrite.
 *
 * WHAT IT NEVER DOES: fail a request. A person who assigned a job has assigned
 * it; whether Meta was reachable a moment later is not their problem and must
 * not become an error on their screen. Every failure here is swallowed into the
 * outbox row, which is exactly where something that still needs doing belongs.
 */

/** Small on purpose: a mutation should not turn into a mail run. */
const BATCH = 5;

export interface DispatchOutcome {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
}

const sendOne = async (
  runtime: ServerRuntime,
  message: OutboxMessage,
): Promise<'sent' | 'failed'> => {
  const now = new Date().toISOString();

  try {
    /*
     * OUTSIDE ANY TRANSACTION.
     *
     * `runtime.write` is deliberately not wrapped around this call — only
     * around the short update that follows it. A `read` unit is used purely to
     * reach the configured adapters; it opens nothing.
     */
    const entry = await runtime.read(({ services }) =>
      services.whatsapp.send({
        to: message.recipient,
        templateName: message.template,
        parameters: [...message.parameters],
        preview: message.preview,
      }),
    );

    await runtime.write(({ repos }) => repos.outbox.markSent(message.id, entry.id, now));
    return 'sent';
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'The message could not be sent.';
    /*
     * The failure is RECORDED, not thrown.
     *
     * `markFailed` leaves the row pending while attempts remain, so the next
     * mutation anybody makes tries again. That is the durability this whole
     * mechanism exists for: before it, a failed send left nothing behind but a
     * sentence on the audit trail.
     */
    await runtime.write(({ repos }) => repos.outbox.markFailed(message.id, reason, now));
    return 'failed';
  }
};

export const dispatchOutbox = async (runtime: ServerRuntime): Promise<DispatchOutcome> => {
  const now = new Date().toISOString();

  /*
   * Claiming is its own short transaction, and it counts the attempt.
   *
   * Two requests draining at once each take rows the other did not — PostgreSQL
   * does that with `for update skip locked` — so a message is never handed to
   * the provider twice because two people saved something in the same second.
   */
  const claimed = await runtime.write(({ repos }) => repos.outbox.claimSendable(BATCH, now));
  if (claimed.length === 0) return { attempted: 0, sent: 0, failed: 0 };

  const outcomes = await Promise.all(claimed.map((message) => sendOne(runtime, message)));

  return {
    attempted: claimed.length,
    sent: outcomes.filter((outcome) => outcome === 'sent').length,
    failed: outcomes.filter((outcome) => outcome === 'failed').length,
  };
};

/**
 * Drains the outbox without ever letting it affect the caller.
 *
 * The response has already been decided by the time this runs. An exception
 * escaping here would turn a successful assignment into a 500, which is the one
 * thing this must not do — so the whole thing is inside a catch that does
 * nothing but note it on the server's own log.
 */
export const drainOutboxQuietly = async (runtime: ServerRuntime): Promise<void> => {
  try {
    await dispatchOutbox(runtime);
  } catch (cause) {
    console.error('[api] outbox dispatch failed', cause);
  }
};
