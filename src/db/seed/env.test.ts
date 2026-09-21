import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFiles } from './env';

const KEY = 'EJE_SEED_ENV_TEST';

afterEach(() => {
  delete process.env[KEY];
});

describe('reading the environment files', () => {
  const directory = (files: Readonly<Record<string, string>>): string => {
    const path = mkdtempSync(join(tmpdir(), 'eje-seed-env-'));
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(path, name), contents);
    }
    return path;
  };

  it('reads .env.local, which is where the documentation says to put it', () => {
    const path = directory({ '.env.local': `${KEY}=from-local\n` });
    expect(loadEnvFiles(path)).toEqual(['.env.local']);
    expect(process.env[KEY]).toBe('from-local');
  });

  it('falls back to .env', () => {
    const path = directory({ '.env': `${KEY}=from-env\n` });
    loadEnvFiles(path);
    expect(process.env[KEY]).toBe('from-env');
  });

  it('prefers .env.local over .env', () => {
    const path = directory({ '.env.local': `${KEY}=local\n`, '.env': `${KEY}=plain\n` });
    loadEnvFiles(path);
    expect(process.env[KEY]).toBe('local');
  });

  it('never overrides what the command line already set', () => {
    process.env[KEY] = 'from-the-command-line';
    const path = directory({ '.env.local': `${KEY}=from-a-file\n` });
    loadEnvFiles(path);
    // The safety checks read DATABASE_URL: a stale file must not redirect it.
    expect(process.env[KEY]).toBe('from-the-command-line');
  });

  it('says nothing and does nothing when there is no file', () => {
    expect(loadEnvFiles(directory({}))).toEqual([]);
  });
});
