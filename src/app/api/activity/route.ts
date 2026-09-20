import { readRoute } from '@/server/api/handler';
import { activityView } from '@/server/api/views';

/**
 * The company-wide audit trail.
 *
 * `loadActivityFeed` refuses a role without `activity.viewAll` outright, rather
 * than returning a filtered page — there is no scoped version of "everything
 * that happened at EJE" worth serving.
 */
export const GET = readRoute('activity.feed', async (context) => {
  const feed = await activityView({
    repos: context.repos,
    services: context.services,
    actor: context.actor.user,
  });
  // A Map does not survive JSON; the pairs do.
  return { events: feed.events, users: feed.users, jobNumbers: [...feed.jobNumbers] };
});
