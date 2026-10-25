import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLLBACK_DOCUMENTS } from './rollback-fixture';

/**
 * The two rollback phases agree about which document holds which state.
 *
 * Phase 2 runs inside a checkout of the LIVE release, which has no
 * `rollback-fixture.ts`, so the probe carries its own copy of the ids. A copy
 * can drift; this reads the probe's text and holds it to the fixture.
 */
describe('the rollback-compatibility fixture', () => {
  it('is copied exactly into the probe that runs inside the live release', () => {
    const probe = readFileSync('scripts/release/rollback-probe.db.test.ts', 'utf8');
    const block = /const DOCUMENTS = \{([\s\S]*?)\} as const;/u.exec(probe)?.[1] ?? '';
    const copied = Object.fromEntries(
      [...block.matchAll(/(\w+): '([0-9a-f-]+)'/gu)].map((match) => [match[1], match[2]]),
    );
    expect(copied).toEqual(ROLLBACK_DOCUMENTS);
  });
});
