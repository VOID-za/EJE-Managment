import { actionRoute } from '@/server/api/action-route';
import { CONTACT_COMMANDS } from '@/server/api/commands/registers';

export const POST = actionRoute('contacts', CONTACT_COMMANDS, 'contactId');
