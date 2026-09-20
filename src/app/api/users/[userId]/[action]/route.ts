import { actionRoute } from '@/server/api/action-route';
import { USER_COMMANDS } from '@/server/api/commands/office';

export const POST = actionRoute('users', USER_COMMANDS, 'userId');
