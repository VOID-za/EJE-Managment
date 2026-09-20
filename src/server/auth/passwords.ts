import 'server-only';
import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id, with OWASP's second recommended configuration: 19 MiB of memory,
 * two iterations, one lane. Memory-hard by design, which is the property that
 * makes a stolen hash expensive to attack on a GPU — and the reason bcrypt is
 * not used here.
 *
 * NOTHING ELSE IN THE APPLICATION HASHES A PASSWORD. The encoded hash carries
 * its own parameters, so raising them later re-hashes on next sign-in rather
 * than invalidating everybody's credentials.
 */
/**
 * `Algorithm.Argon2id` is an ambient const enum, which `verbatimModuleSyntax`
 * refuses to read at runtime. The value is part of the library's published
 * contract and is asserted by this module's own test.
 */
const ARGON2ID = 2;

const PARAMETERS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> => hash(password, PARAMETERS);

/**
 * Whether the password matches. Never throws for a malformed stored hash.
 *
 * A hash the library cannot parse is a corrupt record, not a correct password:
 * returning false is the only safe reading, and the alternative — an exception
 * escaping into the login route — would turn a bad row into a 500 that tells an
 * attacker the account exists.
 */
export const verifyPassword = async (encoded: string, password: string): Promise<boolean> => {
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
};

/**
 * A real hash of a value nobody knows, verified against when the account does
 * not exist.
 *
 * WITHOUT THIS, LOGIN IS A USER ENUMERATION ORACLE. Verifying Argon2id takes
 * tens of milliseconds; returning early for an unknown email takes none, and
 * the difference is measurable from the other side of the internet. So an
 * unknown email is charged exactly the same work as a known one.
 *
 * Computed once, lazily, because computing it is the same cost as a login.
 */
let dummy: Promise<string> | null = null;

export const verifyAgainstDummy = async (password: string): Promise<false> => {
  dummy ??= hashPassword(`no-such-account-${crypto.randomUUID()}`);
  await verifyPassword(await dummy, password);
  return false;
};
