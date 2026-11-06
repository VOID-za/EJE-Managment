/**
 * THESE CHECKS WRITE. v1.7.1 (the owner's report of 6 November 2026).
 *
 * The browser suites sign in as the demonstration accounts and complete,
 * submit, withdraw, record and remove — real writes. They are run against a
 * local server on a disposable database (CI: 127.0.0.1 on a fresh store), and
 * must never reach a shared deployment, where they would put test forms
 * beside a person's ordinary ones. So a suite refuses, before it opens a
 * browser, any address that is not this machine. There is no switch to allow
 * it: the read-only live checks of a release are separate scripts.
 */
export const assertLocalTarget = (base) => {
  let host;
  try {
    host = new URL(base).hostname;
  } catch {
    throw new Error(`Refused: "${base}" is not an address.`);
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return base;
  throw new Error(`Refused: ${base} is not this machine. These checks write test data and run only against a local server.`);
};
