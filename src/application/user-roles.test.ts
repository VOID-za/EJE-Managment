import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, sendPasswordReset, setUserActive, updateUser } from './user-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import {
  activeUsers,
  assignableRolesFor,
  canChangeRole,
  canManageUser,
  disabledUsers,
  type User,
} from '@/domain';

/**
 * Who may administer whom, and who may change a role.
 *
 * A role is a permission set, so setting one is the most security-sensitive
 * thing this screen does. Every assertion below calls an OPERATION: the Users
 * table decides what to offer from the same domain rules, but what actually
 * refuses a request is here, and that is what a production API will rely on.
 *
 * The rule that must not be weakened while role management is added:
 * a Master cannot edit another Master.
 */

const elmarie = seedUser('user-master-elmarie');
const johan = seedUser('user-master-johan');
const christene = seedUser('user-coord-christene');
const sipho = seedUser('user-tech-sipho');

const reread = async (harness: Harness, user: User): Promise<User> => {
  const found = await harness.repos.users.findById(user.id);
  expect(found).not.toBeNull();
  return found!;
};

describe('a Master administers everyone except another Master', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('creates a technician', async () => {
    const created = await createUser(harness.as(elmarie), {
      firstName: 'New',
      lastName: 'Technician',
      email: 'new.technician@eje-demo.co.za',
      mobile: '',
      jobTitle: 'Field Service Technician',
      role: 'technician',
    });
    expect(created.role).toBe('technician');
  });

  it('creates a Coordinator', async () => {
    const created = await createUser(harness.as(elmarie), {
      firstName: 'Second',
      lastName: 'Coordinator',
      email: 'second.coordinator@eje-demo.co.za',
      mobile: '',
      jobTitle: 'Office Coordinator',
      role: 'coordinator',
    });
    expect(created.role).toBe('coordinator');
  });

  it('cannot create a Master', async () => {
    await expect(
      createUser(harness.as(elmarie), {
        firstName: 'New',
        lastName: 'Master',
        email: 'new.master@eje-demo.co.za',
        mobile: '',
        jobTitle: 'Service Manager',
        role: 'master',
      }),
    ).rejects.toThrow(/cannot be created from here/i);
  });

  it('edits a technician and a Coordinator', async () => {
    const tech = await updateUser(harness.as(elmarie), { ...sipho, mobile: '+27 83 555 9999' });
    expect(tech.mobile).toBe('+27 83 555 9999');

    const coord = await updateUser(harness.as(elmarie), {
      ...christene,
      jobTitle: 'Senior Office Coordinator',
    });
    expect(coord.jobTitle).toBe('Senior Office Coordinator');
  });

  it('promotes a technician to Coordinator, and the permissions follow at once', async () => {
    const promoted = await updateUser(harness.as(elmarie), { ...sipho, role: 'coordinator' });
    expect(promoted.role).toBe('coordinator');
    expect((await reread(harness, sipho)).role).toBe('coordinator');

    // The role is the source of truth, so the new permissions are simply what
    // the role has — nothing is carried over from what they were before.
    const now = await reread(harness, sipho);
    expect(canManageUser(now, seedUser('user-tech-lerato'))).toBe(true);
    expect(canManageUser(now, elmarie)).toBe(false);
  });

  it('demotes a Coordinator to technician, and the permissions drop at once', async () => {
    const demoted = await updateUser(harness.as(elmarie), { ...christene, role: 'technician' });
    expect(demoted.role).toBe('technician');

    const now = await reread(harness, christene);
    // Managing users was a Coordinator power. It is gone with the role.
    expect(canManageUser(now, sipho)).toBe(false);
    await expect(
      updateUser(harness.as(now), { ...sipho, mobile: '000' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('records the role change with what it was and what it became', async () => {
    await updateUser(harness.as(elmarie), { ...sipho, role: 'coordinator' });

    const events = await harness.repos.activity.list();
    const entry = events.find((event) => event.type === 'user_role_changed');
    expect(entry).toBeDefined();
    expect(entry!.actorId).toBe(elmarie.id);
    expect(entry!.detail).toContain('from Technician to Coordinator');
    expect(entry!.detail).toContain('Sipho Mahlangu');
    expect(entry!.occurredAt.length).toBeGreaterThan(0);
  });

  it('resets a technician and a Coordinator password', async () => {
    await expect(sendPasswordReset(harness.as(elmarie), sipho)).resolves.toBeDefined();
    await expect(sendPasswordReset(harness.as(elmarie), christene)).resolves.toBeDefined();
  });

  it('disables a technician and a Coordinator', async () => {
    expect((await setUserActive(harness.as(elmarie), sipho, false)).active).toBe(false);
    expect((await setUserActive(harness.as(elmarie), christene, false)).active).toBe(false);
  });
});

describe('a Master account is protected from every other Master', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('cannot be edited', async () => {
    await expect(
      updateUser(harness.as(elmarie), { ...johan, mobile: '+27 00 000 0000' }),
    ).rejects.toThrow(/Master account/i);
    expect((await reread(harness, johan)).mobile).toBe(johan.mobile);
  });

  it('cannot have its role changed', async () => {
    await expect(
      updateUser(harness.as(elmarie), { ...johan, role: 'technician' }),
    ).rejects.toBeInstanceOf(WorkflowError);
    expect((await reread(harness, johan)).role).toBe('master');
  });

  it('cannot be disabled', async () => {
    await expect(setUserActive(harness.as(elmarie), johan, false)).rejects.toBeInstanceOf(
      WorkflowError,
    );
    expect((await reread(harness, johan)).active).toBe(true);
  });

  it('cannot have its password reset', async () => {
    await expect(sendPasswordReset(harness.as(elmarie), johan)).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('offers no role options and no management in the domain rules the screen uses', () => {
    expect(canManageUser(elmarie, johan)).toBe(false);
    expect(assignableRolesFor(elmarie, johan)).toEqual([]);
    expect(canChangeRole(elmarie, johan)).toBe(false);
  });

  it('still lets a Master edit their OWN account, but not their own role', async () => {
    expect(canManageUser(elmarie, elmarie)).toBe(true);
    const saved = await updateUser(harness.as(elmarie), { ...elmarie, mobile: '+27 82 555 0000' });
    expect(saved.mobile).toBe('+27 82 555 0000');

    expect(canChangeRole(elmarie, elmarie)).toBe(false);
    await expect(
      updateUser(harness.as(elmarie), { ...elmarie, role: 'technician' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('cannot be promoted to from below — nobody can make a Master', async () => {
    await expect(
      updateUser(harness.as(elmarie), { ...sipho, role: 'master' }),
    ).rejects.toThrow(/cannot make somebody a Master/i);
    expect((await reread(harness, sipho)).role).toBe('technician');
  });
});

describe('the Coordinator administers technicians only', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('manages a technician', async () => {
    const saved = await updateUser(harness.as(christene), { ...sipho, mobile: '+27 83 555 1111' });
    expect(saved.mobile).toBe('+27 83 555 1111');
    await expect(sendPasswordReset(harness.as(christene), sipho)).resolves.toBeDefined();
    expect((await setUserActive(harness.as(christene), sipho, false)).active).toBe(false);
  });

  it('cannot create a Coordinator', async () => {
    await expect(
      createUser(harness.as(christene), {
        firstName: 'Another',
        lastName: 'Coordinator',
        email: 'another.coordinator@eje-demo.co.za',
        mobile: '',
        jobTitle: 'Office Coordinator',
        role: 'coordinator',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('cannot promote a technician to Coordinator', async () => {
    await expect(
      updateUser(harness.as(christene), { ...sipho, role: 'coordinator' }),
    ).rejects.toThrow(/cannot make somebody a Coordinator/i);
    expect((await reread(harness, sipho)).role).toBe('technician');
  });

  it('cannot manage another Coordinator, including her own role', async () => {
    expect(canChangeRole(christene, christene)).toBe(false);
    await expect(
      updateUser(harness.as(christene), { ...christene, role: 'technician' }),
    ).rejects.toThrow(/your own role/i);
  });

  it('cannot manage a Master in any way', async () => {
    await expect(
      updateUser(harness.as(christene), { ...elmarie, mobile: '0' }),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(setUserActive(harness.as(christene), elmarie, false)).rejects.toBeInstanceOf(
      WorkflowError,
    );
    await expect(sendPasswordReset(harness.as(christene), elmarie)).rejects.toBeInstanceOf(
      WorkflowError,
    );
    await expect(
      updateUser(harness.as(christene), { ...elmarie, role: 'technician' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('is offered technicians only by the rules the screen reads', () => {
    expect(assignableRolesFor(christene, sipho)).toEqual(['technician']);
    expect(canChangeRole(christene, sipho)).toBe(false);
    expect(assignableRolesFor(christene, elmarie)).toEqual([]);
  });
});

describe('a technician administers nobody', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('cannot create, edit, disable or reset anybody', async () => {
    await expect(
      createUser(harness.as(sipho), {
        firstName: 'A',
        lastName: 'B',
        email: 'a.b@eje-demo.co.za',
        mobile: '',
        jobTitle: '',
        role: 'technician',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      updateUser(harness.as(sipho), { ...seedUser('user-tech-lerato'), mobile: '0' }),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      setUserActive(harness.as(sipho), seedUser('user-tech-lerato'), false),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      sendPasswordReset(harness.as(sipho), seedUser('user-tech-lerato')),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('cannot change anybody’s role, including their own', async () => {
    await expect(
      updateUser(harness.as(sipho), { ...sipho, role: 'master' }),
    ).rejects.toBeInstanceOf(WorkflowError);
    expect(assignableRolesFor(sipho, seedUser('user-tech-lerato'))).toEqual([]);
  });
});

describe('active and disabled users', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('counts each group, and a disabled user leaves the active list', async () => {
    const before = await harness.repos.users.list();
    const activeBefore = activeUsers(before).length;
    const disabledBefore = disabledUsers(before).length;
    expect(activeBefore + disabledBefore).toBe(before.length);

    await setUserActive(harness.as(elmarie), sipho, false);

    const after = await harness.repos.users.list();
    expect(activeUsers(after).length).toBe(activeBefore - 1);
    expect(disabledUsers(after).length).toBe(disabledBefore + 1);
    expect(activeUsers(after).some((user) => user.id === sipho.id)).toBe(false);
    expect(disabledUsers(after).some((user) => user.id === sipho.id)).toBe(true);
  });

  it('keeps a disabled user resolvable, so history still names them', async () => {
    await setUserActive(harness.as(elmarie), sipho, false);

    // Not deleted: still on the register, and still the technician on the jobs
    // they worked.
    const stored = await harness.repos.users.findById(sipho.id);
    expect(stored).not.toBeNull();
    expect(stored!.active).toBe(false);

    const jobs = await harness.repos.jobs.list();
    const theirs = jobs.filter((job) => job.primaryTechnicianId === sipho.id);
    expect(theirs.length).toBeGreaterThan(0);
  });

  it('can be reactivated, returning them to the active list', async () => {
    await setUserActive(harness.as(elmarie), sipho, false);
    const back = await setUserActive(harness.as(elmarie), sipho, true);
    expect(back.active).toBe(true);
    expect(activeUsers(await harness.repos.users.list()).some((u) => u.id === sipho.id)).toBe(true);
  });
});
