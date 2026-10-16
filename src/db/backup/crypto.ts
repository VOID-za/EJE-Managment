import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { BackupRefused } from './plan';

/**
 * ENCRYPTING A BACKUP, AND BEING ABLE TO PROVE IT WAS NOT ALTERED. BACKUP-2.
 *
 * BACKUP-1 writes a complete copy of the database and every customer's signed
 * job card into one directory, 0600 inside a 0700 directory. That protects it
 * from the other accounts on the machine it was made on, and nothing else. A
 * backup exists in order to be COPIED — rsynced to another host, pulled onto a
 * laptop, dropped on a USB stick before a migration — and every one of those
 * copies leaves the directory whose permissions were the protection. On the
 * day one of them is lost, what matters is whether the bytes can be read.
 *
 * AES-256-GCM, FOR ONE REASON BEYOND CONFIDENTIALITY. GCM authenticates: the
 * tag fails if a single byte of the ciphertext has changed. That is the second
 * half of this requirement — "integrity-verified" — and it comes from the same
 * primitive rather than from a checksum somebody could recompute after
 * tampering. The manifest's SHA-256 catches corruption; the tag catches
 * corruption AND alteration, because an attacker who edits the file cannot
 * produce a tag that verifies without the key.
 *
 * STREAMED, NOT READ INTO MEMORY. A production dump of this database will not
 * stay small, and a backup tool that fails on a large database is not a backup
 * tool. Nothing here holds more than a chunk at a time.
 *
 * THE KEY COMES FROM THE ENVIRONMENT AND NOWHERE ELSE, exactly as the database
 * password, the Graph secret and the WhatsApp token do. It is never written into
 * the backup directory — a key stored beside the ciphertext is a rename, not an
 * encryption — and it is never printed, not even in part.
 */

/** The 12-byte nonce GCM wants, written at the head of the file. */
const IV_BYTES = 12;

/** The 16-byte authentication tag, written at the tail. */
const TAG_BYTES = 16;

/** `AES-256` means a 32-byte key. Named so the refusals can say it. */
const KEY_BYTES = 32;

/** How to make one, quoted verbatim in every refusal about a missing key. */
export const KEY_RECIPE = 'openssl rand -hex 32';

/**
 * The key, from `EJE_BACKUP_KEY`.
 *
 * ONE FORMAT, NOT THREE. 64 hexadecimal characters. Accepting base64 and raw
 * passphrases as well would mean guessing which one a 44-character string is,
 * and a backup that silently derives a weak key from a short passphrase is the
 * failure this requirement exists to prevent. A wrong-looking value is refused
 * with the command that produces a right one.
 */
export const readBackupKey = (env: Readonly<Record<string, string | undefined>>): Buffer => {
  const configured = (env.EJE_BACKUP_KEY ?? '').trim();
  if (configured.length === 0) {
    throw new BackupRefused(
      'EJE_BACKUP_KEY is not set, so the backup cannot be encrypted — and an unencrypted ' +
        'copy of every signed job card is not a backup this system will write. ' +
        `Generate one with \`${KEY_RECIPE}\`, keep it somewhere that is NOT this server, ` +
        'and set it in the environment. A backup whose key is lost cannot be restored.',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/u.test(configured)) {
    throw new BackupRefused(
      `EJE_BACKUP_KEY must be ${KEY_BYTES} bytes as ${KEY_BYTES * 2} hexadecimal characters ` +
        `(it is ${configured.length} characters). Generate one with \`${KEY_RECIPE}\`. ` +
        'It is refused rather than stretched into a key, because a backup encrypted with ' +
        'something guessable would still report success.',
    );
  }
  return Buffer.from(configured, 'hex');
};

/**
 * A short, public name for a key. NOT the key, and not reversible to it.
 *
 * Recorded in the manifest so an operator holding three keys can tell which one
 * a given backup needs, without the manifest carrying anything secret. It is a
 * SHA-256 of the key truncated to 16 hex characters: enough to tell keys apart,
 * and a preimage attack on it is an attack on SHA-256.
 */
export const keyFingerprint = (key: Buffer): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 16);

export interface EncryptedArtefact {
  /** Bytes of the encrypted file, as it sits on disk. */
  readonly bytes: number;
  /** SHA-256 of the encrypted file — what the manifest checks on disk. */
  readonly sha256: string;
  /** SHA-256 of the ORIGINAL bytes — what a restore checks after decrypting. */
  readonly plainSha256: string;
}

/**
 * Encrypts `source` to `target`: `[iv][ciphertext][tag]`.
 *
 * The plaintext checksum is taken on the way past, so the file is read once.
 * Recording it is deliberate: it is what lets a restore prove the bytes that
 * came OUT are the bytes that went IN, which a ciphertext checksum cannot say.
 * A hash of a multi-megabyte dump reveals nothing about its contents.
 */
export const encryptFile = async (
  source: string,
  target: string,
  key: Buffer,
): Promise<EncryptedArtefact> => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = createHash('sha256');
  const encrypted = createHash('sha256');

  const output = createWriteStream(target, { mode: 0o600 });
  const write = async (chunk: Buffer): Promise<void> => {
    encrypted.update(chunk);
    if (!output.write(chunk)) {
      await new Promise<void>((resolve) => output.once('drain', resolve));
    }
  };

  await write(iv);
  const input = createReadStream(source);
  for await (const chunk of input) {
    const buffer = chunk as Buffer;
    plain.update(buffer);
    await write(cipher.update(buffer));
  }
  await write(cipher.final());
  await write(cipher.getAuthTag());

  await new Promise<void>((resolve, reject) => {
    output.end(() => resolve());
    output.once('error', reject);
  });

  return {
    bytes: statSync(target).size,
    sha256: encrypted.digest('hex'),
    plainSha256: plain.digest('hex'),
  };
};

/**
 * Decrypts `source` to `target` and returns the SHA-256 of what came out.
 *
 * THROWS IF THE FILE WAS ALTERED. The tag is at the tail, so it is read first
 * and handed to the decipher before the body is streamed through it; `final()`
 * is where a tampered or truncated file fails. The output is written as it goes
 * and is NOT to be trusted until this resolves — every caller here writes to a
 * temporary path and deletes it on failure, because a half-written plaintext
 * that nothing authenticated is exactly what must not be left on a disk.
 */
export const decryptFile = async (
  source: string,
  target: string,
  key: Buffer,
): Promise<string> => {
  const total = statSync(source).size;
  if (total < IV_BYTES + TAG_BYTES) {
    throw new BackupRefused(
      `${source} is ${total} bytes, which is too short to be an encrypted artefact. ` +
        'It is truncated, and a truncated backup is refused rather than half-restored.',
    );
  }

  const handle = await open(source, 'r');
  try {
    const iv = Buffer.alloc(IV_BYTES);
    await handle.read(iv, 0, IV_BYTES, 0);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, total - TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const plain = createHash('sha256');
    const body = createReadStream(source, { start: IV_BYTES, end: total - TAG_BYTES - 1 });
    const output = createWriteStream(target, { mode: 0o600 });

    await pipeline(
      body,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          const piece = decipher.update(chunk);
          plain.update(piece);
          yield piece;
        }
        /*
         * WHERE TAMPERING IS CAUGHT. `final()` throws
         * "Unsupported state or unable to authenticate data" when the tag does
         * not match the ciphertext — a flipped byte, a swapped file, a wrong
         * key. It is translated into something an operator can act on.
         */
        let last: Buffer;
        try {
          last = decipher.final();
        } catch {
          throw new BackupRefused(
            `${source} did not authenticate. Either it has been altered or truncated since it ` +
              'was written, or EJE_BACKUP_KEY is not the key it was encrypted with — the ' +
              "manifest records that key's fingerprint. Nothing was restored.",
          );
        }
        plain.update(last);
        yield last;
      },
      output,
    );

    return plain.digest('hex');
  } finally {
    await handle.close();
  }
};
