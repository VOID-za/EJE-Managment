import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveDemoSeedTarget, SeedRefused } from '@/db/seed/guards';
import { isDemoSwitcherEnabled } from '@/server/dev/demo-switcher';
import { buildOcr } from '@/services/ocr';
import { GET as listDemoUsers, POST as switchDemoUser } from '@/app/api/dev/demo-users/route';

/**
 * PRODUCTION GUARDRAILS, CHECKED TOGETHER FOR THE RELEASE. Release readiness,
 * de0d9b6.
 *
 * Each guard has its own tests where it is written; this is the release's view
 * of all three at once, under `EJE_DEPLOYMENT=production` — and with every
 * switch an operator could set by mistake ARMED beside it, because a guard that
 * holds only when nothing else is set is not a guard:
 *
 *   1. the demonstration seed REFUSES, with no override;
 *   2. the demonstration account switcher is INACCESSIBLE — the flag is off, and
 *      the route a browser would call answers 404 to a list and to a switch;
 *   3. text recognition stays OFF unless `EJE_OCR=local` is set explicitly — not
 *      when it is unset, and not when it is set to something that is not `local`.
 */
const ARMED_PRODUCTION = {
  EJE_DEPLOYMENT: 'production',
  NODE_ENV: 'production',
  // Every door someone might leave open, pointed at the database itself.
  DATABASE_URL: 'postgres://eje:secret@127.0.0.1:5432/eje_production',
  EJE_DEMO_SWITCHER: 'eje_production',
  EJE_PRODUCTION_DEMO_SEED: 'eje_production',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('with EJE_DEPLOYMENT=production and every override armed', () => {
  it('REFUSES the demonstration seed, naming the declaration and offering no override', () => {
    let refusal: unknown;
    try {
      resolveDemoSeedTarget(ARMED_PRODUCTION);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SeedRefused);
    expect((refusal as Error).message).toContain('EJE_DEPLOYMENT=production');
    expect((refusal as Error).message).toContain('There is no override');
  });

  it('keeps the demonstration switcher OFF', () => {
    expect(isDemoSwitcherEnabled(ARMED_PRODUCTION)).toBe(false);
  });

  it('answers 404 to a browser asking the switcher for its accounts, and to a switch', async () => {
    for (const [key, value] of Object.entries(ARMED_PRODUCTION)) vi.stubEnv(key, value);

    const list = await listDemoUsers();
    expect(list.status).toBe(404);

    const attempt = await switchDemoUser(
      new NextRequest('http://localhost/api/dev/demo-users', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ email: 'elmarie.coetzee@eje-demo.co.za' }),
      }),
    );
    expect(attempt.status).toBe(404);
    // Not found, not forbidden: a 403 would confirm the switcher exists.
    const body = (await attempt.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_found');
  });

  it('keeps text recognition OFF when EJE_OCR is not set', () => {
    const ocr = buildOcr(ARMED_PRODUCTION).describe();
    expect(ocr.available).toBe(false);
    expect(ocr.engine).toBe('none');
  });

  it.each(['on', 'true', 'yes', 'Local-ish', 'tesseract'])(
    'keeps text recognition OFF when EJE_OCR is "%s" — only `local` turns it on',
    (value) => {
      const ocr = buildOcr({ ...ARMED_PRODUCTION, EJE_OCR: value }).describe();
      expect(ocr.available).toBe(false);
      expect(ocr.engine).toBe('none');
    },
  );

  it('uses the local engine ONLY when EJE_OCR=local is set explicitly', () => {
    const ocr = buildOcr({ ...ARMED_PRODUCTION, EJE_OCR: 'local' }).describe();
    // Whether the binaries are installed decides `available`; what this asserts
    // is that the explicit setting is the only thing that selects an engine.
    expect(ocr.reason).not.toContain('No text-recognition engine is configured');
  });
});
