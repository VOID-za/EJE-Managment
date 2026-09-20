import { actionRoute } from '@/server/api/action-route';
import { SITE_COMMANDS } from '@/server/api/commands/registers';

export const POST = actionRoute('sites', SITE_COMMANDS, 'siteId');
