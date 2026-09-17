import { beforeEach, describe, expect, it } from 'vitest';
import {
  createUser,
  sendPasswordReset,
  setUserActive,
  updateUser,
} from './user-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { activeUsers, disabledUsers, type User } from '@/domain';

/**
 * User administration.
 *
 * Two rules matter commercially: a Master never edits another Master, and a
 * leaver is disabled rather than deleted so historical work keeps naming them.
 */
const elmarie = seedUser('user-master-elmarie');
const denise = seedUser('user-master-denise');
const sipho = seedUser('user-tech-sipho');
const yusuf = seedUser('user-tech-yusuf');

describe('a Master managing non-Master users', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('can add a technician, who can then be signed in as', async () => {
    const created = await createUser(harness.as(elmarie), {
      firstName: 'Nomvula',
      lastName: 'Khumalo',
      email: 'nomvula.khumalo@eje-demo.co.za',
      mobile: '+27 82 555 0199',
      jobTitle: 'Field Service Technician',
      role: 'technician',
    });

    expect(created.role).toBe('technician');
    expect(created.active).toBe(true);
    expect(created.initials).toBe('NK');

    const listed = await harness.repos.users.list();
    expect(listed.some((user) => user.id === created.id)).toBe(true);
  });

  it('refuses a second account on the same email address', async () => {
    await expect(
      createUser(harness.as(elmarie), {
        firstName: 'Another',
        lastName: 'Person',
        email: sipho.email,
        mobile: '',
        jobTitle: '',
        role: 'technician',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses to create a Master account', async () => {
    await expect(
      createUser(harness.as(elmarie), {
        firstName: 'New',
        lastName: 'Master',
        email: 'new.master@eje-demo.co.za',
        mobile: '',
        jobTitle: '',
        role: 'master',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('can edit a technician', async () => {
    const saved = await updateUser(harness.as(elmarie), {
      ...sipho,
      jobTitle: 'Senior Field Service Technician',
    });
    expect(saved.jobTitle).toBe('Senior Field Service Technician');
  });

  it('can send a password reset, which is queued rather than delivered', async () => {
    const result = await sendPasswordReset(harness.as(elmarie), sipho);
    expect(result.sentTo).toBe(sipho.email);
    expect(result.simulated).toBe(true);

    const emails = harness.outbox.listSync().filter((entry) => entry.channel === 'email');
    expect(emails).toHaveLength(1);
    expect(emails[0]?.to).toContain(sipho.email);
  });
});

describe('a Master may NOT manage another Master', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses to edit another Master', async () => {
    await expect(
      updateUser(harness.as(elmarie), { ...denise, jobTitle: 'Changed by a peer' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses to disable another Master', async () => {
    await expect(
      setUserActive(harness.as(elmarie), denise, false),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses to send another Master a password reset', async () => {
    await expect(
      sendPasswordReset(harness.as(elmarie), denise),
    ).rejects.toBeInstanceOf(WorkflowError);
    expect(harness.outbox.listSync()).toHaveLength(0);
  });

  it('still lets a Master edit their own account', async () => {
    const saved = await updateUser(harness.as(elmarie), {
      ...elmarie,
      mobile: '+27 11 555 0111',
    });
    expect(saved.mobile).toBe('+27 11 555 0111');
  });

  it('refuses to let a Master disable themselves', async () => {
    await expect(
      setUserActive(harness.as(elmarie), elmarie, false),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('a technician has no user administration', () => {
  it('cannot create a user', async () => {
    const harness = buildHarness();
    await expect(
      createUser(harness.as(sipho), {
        firstName: 'Sneaky',
        lastName: 'Account',
        email: 'sneaky@eje-demo.co.za',
        mobile: '',
        jobTitle: '',
        role: 'technician',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('disabling a user', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('keeps the record rather than deleting it', async () => {
    const before = await harness.repos.users.list();
    await setUserActive(harness.as(elmarie), sipho, false);
    const after = await harness.repos.users.list();

    expect(after).toHaveLength(before.length);
    const stored = after.find((user) => user.id === sipho.id);
    expect(stored?.active).toBe(false);
    expect(stored?.firstName).toBe(sipho.firstName);
  });

  it('moves the user out of the default active list', async () => {
    await setUserActive(harness.as(elmarie), sipho, false);
    const users = await harness.repos.users.list();

    expect(activeUsers(users).some((user) => user.id === sipho.id)).toBe(false);
    expect(disabledUsers(users).some((user) => user.id === sipho.id)).toBe(true);
  });

  it('leaves historical jobs still naming the technician', async () => {
    const jobsBefore = await harness.repos.jobs.list({ technicianId: sipho.id });
    expect(jobsBefore.length).toBeGreaterThan(0);

    await setUserActive(harness.as(elmarie), sipho, false);

    const jobsAfter = await harness.repos.jobs.list({ technicianId: sipho.id });
    expect(jobsAfter).toHaveLength(jobsBefore.length);

    const users = await harness.repos.users.list();
    const stored = users.find((user) => user.id === sipho.id) as User;
    expect(`${stored.firstName} ${stored.lastName}`).toBe(`${sipho.firstName} ${sipho.lastName}`);
  });

  it('reactivates a returner back into the active list', async () => {
    const restored = await setUserActive(harness.as(elmarie), yusuf, true);
    expect(restored.active).toBe(true);

    const users = await harness.repos.users.list();
    expect(activeUsers(users).some((user) => user.id === yusuf.id)).toBe(true);
  });

  it('refuses a password reset for a disabled account', async () => {
    await expect(
      sendPasswordReset(harness.as(elmarie), yusuf),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});
