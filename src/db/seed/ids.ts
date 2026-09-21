import { createHash } from 'node:crypto';

/**
 * Stable identifiers for seeded records.
 *
 * Every primary key in this schema is a `uuid`, so the seed cannot use readable
 * ids the way the browser demonstration does. It needs ids that are the SAME on
 * every run, on every machine — otherwise running the seed twice would create a
 * second copy of every customer instead of recognising the first.
 *
 * So each record's id is derived from a key that names it (`customer:acme`),
 * hashed into a UUID version 5. Deterministic, collision-free in practice, and
 * derived from nothing but the name — which means a developer can re-run the
 * seed, or run it against a second database, and get the same records.
 *
 * THE NAMESPACE MARKS THEM AS DEMONSTRATION DATA. Every seeded id descends from
 * it, so "is this row from the development seed?" is answerable by recomputing
 * the id rather than by trusting a name somebody might edit.
 */
const NAMESPACE = '7c6a1b1e-3a1d-5b4f-9d2a-1f0e5c9b7a41';

const namespaceBytes = (): Buffer =>
  Buffer.from(NAMESPACE.replace(/-/gu, ''), 'hex');

/**
 * RFC 4122 version 5: SHA-1 over the namespace and the name, with the version
 * and variant bits set. Node has no built-in for it, and it is fifteen lines.
 */
export const demoId = (key: string): string => {
  const digest = createHash('sha1')
    .update(namespaceBytes())
    .update(Buffer.from(key, 'utf8'))
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  // Version 5.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // RFC 4122 variant.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};
