import { integrationsGet, integrationsPost } from '@/server/api/integration-routes';

/** Administration → Integrations. INT-ADMIN-1. See `integration-routes.ts`. */
export const dynamic = 'force-dynamic';
export const GET = integrationsGet;
export const POST = integrationsPost;
