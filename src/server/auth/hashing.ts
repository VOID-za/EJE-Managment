import { hash, verify } from '@node-rs/argon2';

/**
 * The Argon2id implementation itself.
 *
 * Split out of `passwords.ts` for ONE reason: that module carries the
 * `server-only` marker, which is what stops a client component importing it —
 * and the marker also stops a command-line tool importing it. The development
 * seed has to produce a hash the production verifier will accept, so it must
 * use this code rather than a second copy of the parameters.
 *
 * NOTHING ELSE IN THE APPLICATION HASHES A PASSWORD. `passwords.ts` re-exports
 * these, so every server path still goes through the marked module.
 */

/**
 * `Algorithm.Argon2id` is an ambient const enum, which `verbatimModuleSyntax`
 * refuses to read at runtime. The value is part of the library's published
 * contract and is asserted by this module's own test.
 */
const ARGON2ID = 2;

/**
 * OWASP's second recommended configuration: 19 MiB of memory, two iterations,
 * one lane. Memory-hard by design, which is the property that makes a stolen
 * hash expensive to attack on a GPU — and the reason bcrypt is not used here.
 *
 * The encoded hash carries its own parameters, so raising them later re-hashes
 * on next sign-in rather than invalidating everybody's credentials.
 */
export const PARAMETERS = {
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
