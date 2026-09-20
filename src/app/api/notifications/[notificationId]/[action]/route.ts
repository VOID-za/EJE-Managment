import { actionRoute } from '@/server/api/action-route';
import { NOTIFICATION_COMMANDS } from '@/server/api/commands/office';

export const POST = actionRoute('notifications', NOTIFICATION_COMMANDS, 'notificationId');
