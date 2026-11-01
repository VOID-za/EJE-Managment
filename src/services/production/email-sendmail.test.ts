import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_REQUEST_PREFIX,
  GraphEmailService,
  graphClientAssertion,
  readGraphEmailConfiguration,
  describeEmailConfiguration,
} from './email';
import { SystemClock } from '../simulated/system';
import type { StorageService, StoredDocument } from '../ports';

/**
 * INT-EMAIL-5: Microsoft Graph with the least privilege — one `sendMail` call
 * (Mail.Send alone), from sales@ejeie.co.za, saved to its Sent Items, with a
 * certificate credential preferred over a secret. Driven by injected HTTP
 * answers; Microsoft's side is not asserted and cannot honestly be.
 */

const document: StoredDocument = {
  storageKey: 'documents/EJE-2078.pdf',
  fileName: 'EJE-2078-Signed-Job-Card.pdf',
  contentType: 'application/pdf',
  bytes: new TextEncoder().encode('%PDF-1.7 signed'),
};
const storage: StorageService = {
  resolveUrl: () => '',
  storeUpload: () => Promise.reject(new Error('unused')),
  putDocument: () => Promise.resolve(),
  getDocument: () => Promise.resolve(document),
  remove: () => Promise.resolve(),
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const THUMBPRINT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const keyFile = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'eje-graph-'));
  const path = join(directory, 'graph-mail.pem');
  writeFileSync(path, pem);
  return path;
};

interface Call {
  readonly url: string;
  readonly body: string;
}

const graph = (calls: Call[]): typeof fetch =>
  ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    if (String(url).includes('/oauth2/v2.0/token')) {
      return Promise.resolve(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 202, headers: { 'request-id': 'req-123' } }));
  }) as typeof fetch;

describe('the certificate credential', () => {
  it('is read when the path and thumbprint are set, and wins over a secret', () => {
    const config = readGraphEmailConfiguration({
      EMAIL_GRAPH_TENANT_ID: 'tenant',
      EMAIL_GRAPH_CLIENT_ID: 'client',
      EMAIL_GRAPH_CLIENT_SECRET: 'also-a-secret',
      EMAIL_GRAPH_CERTIFICATE_PATH: '/etc/eje/graph-mail.pem',
      EMAIL_GRAPH_CERTIFICATE_THUMBPRINT: 'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:12:34:56:78',
      EMAIL_SENDER: 'sales@ejeie.co.za',
    });
    expect(config).toMatchObject({ clientSecret: '', certificatePath: '/etc/eje/graph-mail.pem', certificateThumbprint: THUMBPRINT });
  });

  it('half a certificate is not a credential, and the diagnosis says so by NAME', () => {
    const env = { EMAIL_GRAPH_TENANT_ID: 't', EMAIL_GRAPH_CLIENT_ID: 'c', EMAIL_GRAPH_CERTIFICATE_PATH: '/x.pem', EMAIL_SENDER: 'sales@ejeie.co.za' };
    expect(readGraphEmailConfiguration(env)).toBeNull();
    expect(describeEmailConfiguration(env).problems.join(' ')).toMatch(/EMAIL_GRAPH_CERTIFICATE_THUMBPRINT/u);
  });

  it('signs a client assertion Microsoft can verify with the uploaded public key', () => {
    const assertion = graphClientAssertion(
      { tenantId: 'tenant', clientId: 'client', loginUrl: 'https://login.microsoftonline.com', certificateThumbprint: THUMBPRINT },
      pem,
      1_793_520_000,
    );
    const [header, claims, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      x5t: Buffer.from(THUMBPRINT, 'hex').toString('base64url'),
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      aud: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      iss: 'client',
      sub: 'client',
      nbf: 1_793_520_000,
      exp: 1_793_520_600,
    });
    const verified = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(verified).toBe(true);
  });

  it('asks for the token with the assertion — no secret is sent', async () => {
    const calls: Call[] = [];
    const config = readGraphEmailConfiguration({
      EMAIL_GRAPH_TENANT_ID: 'tenant',
      EMAIL_GRAPH_CLIENT_ID: 'client',
      EMAIL_GRAPH_CERTIFICATE_PATH: keyFile(),
      EMAIL_GRAPH_CERTIFICATE_THUMBPRINT: THUMBPRINT,
      EMAIL_SENDER: 'sales@ejeie.co.za',
    })!;
    await new GraphEmailService(config, storage, new SystemClock(), graph(calls)).send({ to: ['a@b.co.za'], subject: 's', body: 'b' });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(form.get('client_assertion')?.split('.')).toHaveLength(3);
    expect(form.has('client_secret')).toBe(false);
  });

  it('an unreadable key file is a refused credential, said plainly, and nothing is sent', async () => {
    const calls: Call[] = [];
    const config = readGraphEmailConfiguration({
      EMAIL_GRAPH_TENANT_ID: 'tenant',
      EMAIL_GRAPH_CLIENT_ID: 'client',
      EMAIL_GRAPH_CERTIFICATE_PATH: join(tmpdir(), 'does-not-exist.pem'),
      EMAIL_GRAPH_CERTIFICATE_THUMBPRINT: THUMBPRINT,
      EMAIL_SENDER: 'sales@ejeie.co.za',
    })!;
    await expect(new GraphEmailService(config, storage, new SystemClock(), graph(calls)).send({ to: ['a@b.co.za'], subject: 's', body: 'b' })).rejects.toMatchObject({
      kind: 'credentials_rejected',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('sendMail', () => {
  const config = readGraphEmailConfiguration({
    EMAIL_GRAPH_TENANT_ID: 'tenant',
    EMAIL_GRAPH_CLIENT_ID: 'client',
    EMAIL_GRAPH_CLIENT_SECRET: 'secret',
    EMAIL_SENDER: 'sales@ejeie.co.za',
  })!;

  it('sends AS sales@ejeie.co.za, saves to Sent Items, carries EJE’s reference, and records Microsoft’s request id', async () => {
    const calls: Call[] = [];
    const service = new GraphEmailService(config, storage, new SystemClock(), graph(calls));
    expect(service.sender).toBe('sales@ejeie.co.za');
    const receipt = await service.send({
      to: ['pieter@abc.co.za'],
      subject: 'EJE-2078 — Signed Job Card — Breakdown',
      body: 'Good day',
      attachments: [{ fileName: document.fileName, storageKey: document.storageKey }],
      reference: 'email-42',
    });
    expect(calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/users/sales%40ejeie.co.za/sendMail');
    const payload = JSON.parse(calls[1]!.body) as {
      saveToSentItems: boolean;
      message: { subject: string; internetMessageHeaders: { name: string; value: string }[]; attachments: { name: string }[] };
    };
    expect(payload.saveToSentItems).toBe(true);
    expect(payload.message.subject).toBe('EJE-2078 — Signed Job Card — Breakdown');
    expect(payload.message.internetMessageHeaders).toEqual([{ name: 'X-EJE-Reference', value: 'email-42' }]);
    expect(payload.message.attachments.map((attachment) => attachment.name)).toEqual([document.fileName]);
    expect(receipt).toMatchObject({ messageId: `${GRAPH_REQUEST_PREFIX}req-123`, state: 'pending_delivery' });
  });

  it('does not pretend to know what became of a sendMail: there is nothing it may read', async () => {
    const calls: Call[] = [];
    const service = new GraphEmailService(config, storage, new SystemClock(), graph(calls));
    expect(await service.deliveryState(`${GRAPH_REQUEST_PREFIX}req-123`)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a timeout while the MESSAGE was out is marked uncertain; one while asking for a token is not', async () => {
    const timeoutOn = (fragment: string): typeof fetch =>
      ((url: string) =>
        String(url).includes(fragment)
          ? Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
          : Promise.resolve(new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }))) as typeof fetch;
    await expect(new GraphEmailService(config, storage, new SystemClock(), timeoutOn('/sendMail')).send({ to: ['a@b.co.za'], subject: 's', body: 'b' })).rejects.toMatchObject({
      kind: 'timed_out',
      uncertain: true,
    });
    await expect(new GraphEmailService(config, storage, new SystemClock(), timeoutOn('/oauth2/')).send({ to: ['a@b.co.za'], subject: 's', body: 'b' })).rejects.toMatchObject({
      kind: 'timed_out',
      uncertain: false,
    });
  });
});
