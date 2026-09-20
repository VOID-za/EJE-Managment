import { actionRoute } from '@/server/api/action-route';
import { CUSTOMER_COMMANDS } from '@/server/api/commands/registers';

export const POST = actionRoute('customers', CUSTOMER_COMMANDS, 'customerId');
