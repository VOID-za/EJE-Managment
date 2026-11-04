import { beforeEach, describe, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';
import { scenarios } from './checklist-selection.scenarios';

/**
 * WHICH SERVICE CHECKLIST, ON THE DEMONSTRATION BACKEND. CHK-SRC-1.
 *
 * The scenarios are in `checklist-selection.scenarios.ts`; the same ones run
 * on PostgreSQL in `checklist-selection.db.test.ts`.
 */
const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('the Service checklist choice, on the demonstration backend', () => {
  beforeEach(() => {
    startTestServer();
  });

  const cases = scenarios({
    master: () => signedInAs(DEMO_USERS.master),
    technician: () => signedInAs(DEMO_USERS.technician),
    otherTechnician: () => signedInAs(DEMO_USERS.otherTechnician),
    technicianId: (master) => userId(master, DEMO_USERS.technician),
    record: {
      customerId: 'cust-abc',
      siteId: 'site-abc-jhb',
      contactId: 'contact-abc-jhb',
      machineId: 'machine-abc-lv40',
    },
  });

  for (const [name, run] of Object.entries(cases)) it(name, run);
});
