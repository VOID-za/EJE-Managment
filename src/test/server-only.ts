/**
 * Stand-in for the `server-only` marker package, used by the test runner.
 *
 * `server-only` deliberately throws when it is imported without React's
 * `react-server` condition, which is exactly what makes it useful: a client
 * component that imports a server module fails the build. Vitest is neither, so
 * the marker is aliased to this empty module and the guarantee is kept where it
 * matters — `npm run build`, which still resolves the real package.
 */
export {};
