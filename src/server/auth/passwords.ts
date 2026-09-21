import 'server-only';
import { hashPassword, verifyPassword } from './hashing';

/**
 * Password hashing, for the server.
 *
 * The implementation is in `hashing.ts` and is re-exported here; this module
 * adds the `server-only` marker, so a client component that reaches for a
 * password hash fails the build. The development seed imports `hashing.ts`
 * directly — a command line is not a client — and therefore produces hashes
 * this verifier accepts, with the same parameters, rather than a second
 * implementation that could drift.
 */
export { hashPassword, verifyPassword, PARAMETERS } from './hashing';

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
