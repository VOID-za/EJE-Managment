import { actionRoute } from '@/server/api/action-route';
import { CONVERSATION_COMMANDS } from '@/server/api/commands/office';

export const POST = actionRoute('conversations', CONVERSATION_COMMANDS, 'conversationId');
