import { actionRoute } from '@/server/api/action-route';
import { CHECKLIST_COMMANDS } from '@/server/api/commands/office';

export const POST = actionRoute('checklists', CHECKLIST_COMMANDS, 'templateId');
