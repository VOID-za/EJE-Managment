import 'server-only';
import { createHash } from 'node:crypto';
import type { WhatsAppActivationGate } from '@/services/production/whatsapp';
import type { IsoDateTime } from '@/domain';
import type { ServerRuntime } from '@/server/runtime';

/**
 * IS THE DEDICATED EJE WHATSAPP NUMBER IN USE? The owner's decision
 * (1 November 2026): it stays "Not configured" until the dedicated number and
 * the Meta credentials are set AND a real API test succeeded.
 *
 * The proof is a row in `integration_state` under `whatsapp_activation`: the
 * fingerprint of the sending configuration at the moment Meta accepted a test
 * message from the dedicated number. A new token, a new phone number id or a
 * new dedicated number is a new fingerprint — and needs a new test. The
 * fingerprint is a hash; no value is stored.
 */

export const WHATSAPP_ACTIVATION_SERVICE = 'whatsapp_activation';

/** What identifies the sender. Test recipients are not part of it. */
const SENDING_NAMES = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_DEDICATED_NUMBER', 'WHATSAPP_TEMPLATE_LANGUAGE'] as const;

export const whatsappSendingFingerprint = (source: Readonly<Record<string, string | undefined>> = process.env): string =>
  createHash('sha256')
    .update(SENDING_NAMES.map((name) => `${name}=${(source[name] ?? '').trim()}`).join('\n'))
    .digest('hex');

export interface WhatsAppActivation {
  readonly active: boolean;
  /** When the test that proved this configuration was accepted, or null. */
  readonly provenAt: string | null;
}

const KEY = Symbol.for('eje.whatsapp.activation');
type Holder = { [KEY]?: { active: boolean; checkedAt: number } };
const holder = globalThis as Holder;
const cache = (): { active: boolean; checkedAt: number } => (holder[KEY] ??= { active: false, checkedAt: 0 });

export const readWhatsAppActivation = async (runtime: ServerRuntime): Promise<WhatsAppActivation> => {
  const state = await runtime.read((unit) => unit.repos.integrations.findState(WHATSAPP_ACTIVATION_SERVICE));
  const active = state !== null && state.fingerprint === whatsappSendingFingerprint();
  cache().active = active;
  cache().checkedAt = Date.now();
  return { active, provenAt: active ? (state?.summary ?? null) : null };
};

/** A real test was accepted by Meta from the dedicated number: record the proof. */
export const recordWhatsAppActivation = async (runtime: ServerRuntime, at: IsoDateTime): Promise<void> => {
  await runtime.write((unit) => unit.repos.integrations.saveState(WHATSAPP_ACTIVATION_SERVICE, whatsappSendingFingerprint(), at, at));
  cache().active = true;
  cache().checkedAt = Date.now();
};

/**
 * The gate the WhatsApp adapter consults. `active` is the last answer (kept
 * fresh by the worker every minute and by every check); `confirm` asks the
 * store when the last answer is over a minute old.
 */
export const whatsappActivationGate = (runtime: () => ServerRuntime): WhatsAppActivationGate => ({
  get active() {
    return cache().active;
  },
  async confirm() {
    if (Date.now() - cache().checkedAt < 60_000) return cache().active;
    try {
      return (await readWhatsAppActivation(runtime())).active;
    } catch {
      return false;
    }
  },
});
