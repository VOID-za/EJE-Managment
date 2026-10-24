import { readFileSync } from 'node:fs';
import { keyFingerprint } from './crypto';

/**
 * `npm run backup:escrow-check -- --expect <fingerprint>` — IS THE COPY OF THE
 * BACKUP KEY THAT IS *NOT* ON THE SERVER THE RIGHT ONE? BACKUP-2, security
 * audit of 24 October 2026.
 *
 * `backup:key-check` answers this on the VPS, and that is the problem with it
 * for the one check that matters most: to test the escrowed copy there, the
 * escrowed copy has to be carried TO the server — onto the machine whose loss
 * it exists to survive, through a terminal, a clipboard and maybe a chat.
 *
 * THIS RUNS WHERE THE ESCROWED COPY ALREADY IS — the owner's own computer,
 * beside the password manager or the USB stick — and needs nothing from the
 * server but the fingerprint, which is not secret: it is printed by every
 * backup run and recorded in every manifest. The key is read from a hidden
 * prompt or a file, never from an argument, and nothing about it is printed:
 * not the key, not a part of it, not its length.
 *
 * Exit status: 0 MATCH, 1 NO MATCH, 2 not a key at all or bad usage.
 */

export type EscrowVerdict =
  | { readonly kind: 'match'; readonly fingerprint: string }
  | { readonly kind: 'mismatch'; readonly fingerprint: string }
  | { readonly kind: 'malformed' };

/** Compares a candidate key's fingerprint with the one a backup recorded. */
export const escrowVerdict = (candidate: string, expected: string): EscrowVerdict => {
  // A trailing newline from a file or a paste is not part of the key; anything else is.
  const key = candidate.trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(key)) return { kind: 'malformed' };
  const fingerprint = keyFingerprint(Buffer.from(key, 'hex'));
  return fingerprint === expected.trim().toLowerCase()
    ? { kind: 'match', fingerprint }
    : { kind: 'mismatch', fingerprint };
};

export const isFingerprint = (value: string): boolean => /^[0-9a-f]{16}$/u.test(value.trim().toLowerCase());

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

/** Reads one line from the terminal without echoing it. */
const hiddenLine = (prompt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      let text = '';
      input.setEncoding('utf8');
      input.on('data', (chunk: string) => {
        text += chunk;
      });
      input.on('end', () => resolve(text));
      input.on('error', reject);
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let text = '';
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(text);
          return;
        }
        if (character === '\u0003') {
          input.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (character === '\u0008' || character === '\u007f') {
          text = text.slice(0, -1);
          continue;
        }
        text += character;
      }
    };
    input.on('data', onData);
  });

const main = async (): Promise<void> => {
  const expected = argument('expect') ?? '';
  if (!isFingerprint(expected)) {
    process.stderr.write(
      'Name the fingerprint the backup recorded (16 hex characters, printed by every backup run):\n\n' +
        '  npm run backup:escrow-check -- --expect 23dba6772da10057\n' +
        '  npm run backup:escrow-check -- --expect 23dba6772da10057 --key-file E:\\eje-backup-key\n',
    );
    process.exitCode = 2;
    return;
  }

  const file = argument('key-file');
  const candidate =
    file === null
      ? await hiddenLine('Paste the escrowed backup key (nothing will be shown), then Enter: ')
      : readFileSync(file, 'utf8');
  const verdict = escrowVerdict(candidate, expected);

  process.stdout.write(`\nneeds key  ${expected.trim().toLowerCase()}\n`);
  if (verdict.kind === 'malformed') {
    process.stdout.write(
      'NOT A BACKUP KEY. A key is 64 hexadecimal characters; what was given is not, so it was\n' +
        'not compared. Check the copy for missing characters or a different secret.\n',
    );
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`you have   ${verdict.fingerprint}\n\n`);
  if (verdict.kind === 'match') {
    process.stdout.write(
      'MATCH. The escrowed copy is the key the backups are encrypted with, and it was checked\n' +
        'without going anywhere near the server.\n',
    );
    return;
  }
  process.stdout.write(
    'NO MATCH. This copy CANNOT decrypt the backups. Do not discard the key on the server until\n' +
      'a copy that matches is stored somewhere that is not the server.\n',
  );
  process.exitCode = 1;
};

// Only when run as a command; the test imports the pure functions above.
if (process.argv[1]?.replace(/\\/gu, '/').endsWith('src/db/backup/escrow-check.ts')) {
  void main().catch((cause: unknown) => {
    process.stderr.write(`escrow-check  FAILED: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 2;
  });
}
