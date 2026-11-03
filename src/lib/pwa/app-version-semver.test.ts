import { afterEach, describe, expect, it } from 'vitest';
import { isKnownVersion, isNewRelease, serverBuildOf, serverVersionOf, versionLabel } from './app-version';
import { ApiTestClient } from '@/test/api-harness';

/**
 * VERSION-1 (3 November 2026): people see a semantic version ("v1.0.1"); the
 * COMMIT still decides whether a release is new and still identifies the
 * deployment. A build without a version is shown by its short commit.
 */
describe('the version people see, and the commit that decides', () => {
  it('a semantic version is shown as "v1.0.1"; a build without one by its short commit', () => {
    expect(versionLabel('1.0.1', '9fa858f')).toBe('v1.0.1');
    expect(versionLabel('unknown', '9fa858fe0b0e63c2')).toBe('9fa858f');
    expect(versionLabel(null, 'unknown')).toBe('unknown');
    expect(isKnownVersion('1.10.0')).toBe(true);
    expect(isKnownVersion('v1.0.0')).toBe(false);
    expect(isKnownVersion('unknown')).toBe(false);
  });

  it('reads the version from /api/health beside the commit, which is still read as before', () => {
    const body = { status: 'ok', build: { commit: 'abc1234', builtAt: 'x', version: '1.0.1' } };
    expect(serverBuildOf(body)).toBe('abc1234');
    expect(serverVersionOf(body)).toBe('1.0.1');
    // An older release, with no version: the commit still works, the version is simply absent.
    expect(serverVersionOf({ build: { commit: 'abc1234' } })).toBeNull();
    expect(serverVersionOf({ build: { commit: 'abc1234', version: 'unknown' } })).toBeNull();
  });

  it('detection is unchanged: a new COMMIT is a new release; the same commit never notifies itself', () => {
    expect(isNewRelease('7acb77e', 'b2c3d4e')).toBe(true);
    expect(isNewRelease('7acb77e', '7acb77e')).toBe(false);
    expect(isNewRelease('7acb77e', null)).toBe(false);
  });
});

describe('GET /api/health reports the semantic version AND the commit', () => {
  const saved = process.env.EJE_APP_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.EJE_APP_VERSION;
    else process.env.EJE_APP_VERSION = saved;
  });

  it('build.version is the stamped version; build.commit is still there for diagnostics', async () => {
    process.env.EJE_APP_VERSION = '1.0.1';
    const response = await new ApiTestClient().get('/api/health');
    const build = (response.raw as { build: { commit: string; version: string } }).build;
    expect(build.version).toBe('1.0.1');
    expect(typeof build.commit).toBe('string');
    expect(build.commit.length).toBeGreaterThan(0);
  });
});
