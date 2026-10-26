import type { Sql } from 'postgres';

/**
 * How many customers still have more than one ACTIVE site. SITE-1.
 *
 * Archived sites do not count: they are history, kept so the jobs done there
 * read correctly. The preflight reports this so an operator knows when the
 * one-site database constraint can be added (`checkCustomerSites`).
 */
export const countLegacyMultiSiteCustomers = async (sql: Sql): Promise<number> => {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from (
      select customer_id from sites where archived_at is null
      group by customer_id having count(*) > 1
    ) as legacy
  `;
  return Number(rows[0]?.count ?? '0');
};
