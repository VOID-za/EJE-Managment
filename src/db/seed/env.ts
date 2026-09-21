import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Reads `.env.local` and `.env` the way a developer expects.
 *
 * `next dev` loads them; a command-line script does not, and `docs/database.md`
 * tells people to put `DATABASE_URL` in `.env.local` — so without this, the
 * seed would refuse to run for somebody who had followed the instructions
 * exactly. Node parses the file itself, so this costs no dependency.
 *
 * A variable ALREADY SET IN THE ENVIRONMENT ALWAYS WINS. That matters for the
 * safety checks: `DATABASE_URL=… npm run db:seed` must mean what it says, and a
 * stale `.env` must not be able to redirect it somewhere else.
 */
const FILES = ['.env.local', '.env'];

export const loadEnvFiles = (cwd: string = process.cwd()): readonly string[] => {
  const loaded: string[] = [];

  for (const file of FILES) {
    let contents: string;
    try {
      contents = readFileSync(resolve(cwd, file), 'utf8');
    } catch {
      continue;
    }

    const parsed = parseEnv(contents);
    let used = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      used = true;
    }
    if (used) loaded.push(file);
  }

  return loaded;
};
