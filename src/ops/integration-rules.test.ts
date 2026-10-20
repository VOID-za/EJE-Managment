import { describe, expect, it } from 'vitest';
import {
  checkEmailReadiness,
  checkWhatsAppReadiness,
  integrationsFailed,
  isCredentialRefusal,
  type EmailFacts,
  type WhatsAppFacts,
} from './integration-rules';

/**
 * READY TO MESSAGE A CUSTOMER, WITHOUT MESSAGING ONE. MANDATE-3.
 *
 * The distinctions being tested are the ones an operator gets wrong: a
 * deployment that is configured but unproven is not ready, a provider that
 * cannot be reached is not a refused credential, and WhatsApp credentials with
 * no approved template cannot message anybody however good the token is.
 */
const email = (over: Partial<EmailFacts> = {}): EmailFacts => ({
  configured: true,
  missing: [],
  problems: [],
  probe: null,
  ...over,
});

const whatsapp = (over: Partial<WhatsAppFacts> = {}): WhatsAppFacts => ({
  configured: true,
  missing: [],
  probe: null,
  templates: ['eje_job_assigned', 'eje_site_location'],
  approvalVerified: null,
  ...over,
});

describe('customer email', () => {
  it('reports an unconfigured deployment by VARIABLE NAME and says who must act', () => {
    const check = checkEmailReadiness(
      email({
        configured: false,
        missing: ['EMAIL_GRAPH_CLIENT_SECRET', 'EMAIL_SENDER'],
      }),
    );

    expect(check.readiness).toBe('not_configured');
    expect(check.detail).toContain('EMAIL_GRAPH_CLIENT_SECRET');
    expect(check.next).toMatch(/EJE must supply/u);
    // A deployment that cannot send is not a failure of this check: it is the
    // state EJE are in until they supply a tenant, and saying so is the point.
    expect(integrationsFailed([check])).toBe(false);
  });

  it('does NOT call a configured deployment ready until something was asked of the provider', () => {
    const check = checkEmailReadiness(email());

    expect(check.readiness).toBe('configured');
    expect(check.detail).toMatch(/NOTHING WAS ASKED OF\s+MICROSOFT/u);
    expect(check.next).toMatch(/--probe/u);
  });

  it('calls it ready when the credential was accepted, and still asks for approval to send', () => {
    const check = checkEmailReadiness(
      email({ probe: { ok: true, detail: 'sender mailbox read.', credentialRefused: false } }),
    );

    expect(check.readiness).toBe('ready');
    // The one thing a green check must not imply.
    expect(check.next).toMatch(/needs EJE’s explicit approval/u);
  });

  it('REFUSES when the credential was refused', () => {
    const check = checkEmailReadiness(
      email({
        probe: { ok: false, detail: '401 invalid_client.', credentialRefused: true },
      }),
    );

    expect(check.readiness).toBe('refused');
    expect(check.next).toMatch(/app registration/u);
    expect(integrationsFailed([check])).toBe(true);
  });

  it('does not blame the credential for a provider it could not reach', () => {
    const check = checkEmailReadiness(
      email({ probe: { ok: false, detail: 'connect ETIMEDOUT.', credentialRefused: false } }),
    );

    // An unreachable provider says nothing about the configuration, and
    // reporting it as a refusal sends somebody to rotate a working secret.
    expect(check.readiness).toBe('configured');
    expect(check.detail).toMatch(/this moment’s network/u);
    expect(integrationsFailed([check])).toBe(false);
  });
});

describe('WhatsApp', () => {
  it('REFUSES when Meta has no approved template under the name this build sends', () => {
    // The names live in the application's own constants, so what EJE have to
    // do is get templates approved UNDER THOSE NAMES. A token is not enough.
    const check = checkWhatsAppReadiness(whatsapp({ approvalVerified: false }));

    expect(check.readiness).toBe('refused');
    expect(check.detail).toContain('eje_job_assigned');
    expect(check.next).toMatch(/Meta Business Manager/u);
  });

  it('names the templates that must be approved even before anything is asked of Meta', () => {
    const check = checkWhatsAppReadiness(whatsapp());
    expect(check.readiness).toBe('configured');
    expect(check.detail).toContain('eje_site_location');
  });

  it('reports what is missing when it is not configured at all', () => {
    const check = checkWhatsAppReadiness(
      whatsapp({ configured: false, missing: ['WHATSAPP_ACCESS_TOKEN'] }),
    );
    expect(check.readiness).toBe('not_configured');
    expect(check.detail).toContain('WHATSAPP_ACCESS_TOKEN');
    expect(check.detail).toMatch(/simulated outbox/u);
  });

  it('is READY only once the token is accepted AND the templates are known to be approved', () => {
    const tokenOnly = checkWhatsAppReadiness(
      whatsapp({ probe: { ok: true, detail: 'phone number read.', credentialRefused: false } }),
    );
    // An accepted token with unverified templates is not readiness, and saying
    // it is would be the most expensive kind of false green: the office would
    // press send and the customer would get nothing.
    expect(tokenOnly.readiness).toBe('configured');
    expect(tokenOnly.detail).toMatch(/TEMPLATE APPROVAL WAS NOT CHECKED/u);

    const both = checkWhatsAppReadiness(
      whatsapp({
        probe: { ok: true, detail: 'phone number read.', credentialRefused: false },
        approvalVerified: true,
      }),
    );
    expect(both.readiness).toBe('ready');
  });

  it('REFUSES a rejected token', () => {
    const check = checkWhatsAppReadiness(
      whatsapp({ probe: { ok: false, detail: '401 OAuthException.', credentialRefused: true } }),
    );
    expect(check.readiness).toBe('refused');
    expect(integrationsFailed([check])).toBe(true);
  });
});

describe('which HTTP answers mean the credential is wrong', () => {
  it('counts 401, 403 and 404', () => {
    // 404 on a sender mailbox is configuration too: the mailbox named does not
    // exist, and no retry fixes that.
    for (const status of [401, 403, 404]) expect(isCredentialRefusal(status), `${status}`).toBe(true);
  });

  it('does not count a provider having a bad day', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isCredentialRefusal(status), `${status}`).toBe(false);
    }
  });
});

describe('no check ever prints a value', () => {
  it('keeps secrets out of every sentence it produces', () => {
    const SECRET = 'super-secret-client-secret-value';
    const checks = [
      checkEmailReadiness(
        email({
          problems: [`EMAIL_SENDER is not an address`],
          probe: { ok: false, detail: `401 invalid_client`, credentialRefused: true },
        }),
      ),
      checkWhatsAppReadiness(
        whatsapp({ probe: { ok: false, detail: '401 OAuthException', credentialRefused: true } }),
      ),
    ];

    for (const check of checks) {
      expect(`${check.detail} ${check.next}`).not.toContain(SECRET);
    }
  });
});
