import { actionRoute } from '@/server/api/action-route';
import { LIBRARY_COMMANDS } from '@/server/api/commands/office';

export const POST = actionRoute('library', LIBRARY_COMMANDS, 'documentId');
