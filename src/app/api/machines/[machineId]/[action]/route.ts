import { actionRoute } from '@/server/api/action-route';
import { MACHINE_COMMANDS } from '@/server/api/commands/registers';

export const POST = actionRoute('machines', MACHINE_COMMANDS, 'machineId');
