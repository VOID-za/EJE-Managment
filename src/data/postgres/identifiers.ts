/**
 * Identifiers that cannot exist.
 *
 * Every primary key in this schema is a `uuid`, and PostgreSQL rejects a
 * malformed one with a type error rather than an empty result. That matters
 * because ids now arrive from URLs: `/api/jobs/EJE-1068/accept` carries the
 * number a person reads, and a hand-typed `/api/customers/whatever` carries
 * nonsense. Either would surface as a 500 — an internal error for what is
 * simply a record that is not there, and, in the second case, a different
 * answer for a malformed id than for an id that merely does not exist.
 *
 * A LOOKUP BY AN ID THAT CANNOT EXIST IS A MISS, not a failure. The guard is at
 * the repository because that is where the shape of the key is known; nothing
 * above it should have to reason about uuids.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const isUuid = (value: string): boolean => UUID.test(value);
