import { actionRoute } from '@/server/api/action-route';
import { AVAILABILITY_COMMANDS } from '@/server/api/commands/office';

export const POST = actionRoute('availability', AVAILABILITY_COMMANDS, 'recordId');
