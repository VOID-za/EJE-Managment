import { asUserId, type User } from '@/domain';
import { demoId } from './ids';
import { timeAgo } from './calendar';

/**
 * The development sign-in accounts.
 *
 * FICTIONAL PEOPLE, DEVELOPMENT ONLY. The names are deliberately obvious —
 * "John Master", "Mike Technician" — so nobody reviewing a screen can mistake a
 * seeded account for a real member of EJE's staff.
 *
 * They authenticate through the real login screen, against a real Argon2id hash
 * written by the seed. There is no demonstration sign-in path and no role
 * picker: the role comes back from the server with the session, exactly as it
 * will for EJE's own accounts.
 */
export const DEMO_PASSWORD = 'EjeDemo#2026';

export interface SeedUser {
  readonly user: User;
  readonly password: string;
}

const person = (
  key: string,
  firstName: string,
  lastName: string,
  initials: string,
  email: string,
  mobile: string,
  role: User['role'],
  jobTitle: string,
  createdDaysAgo: number,
): SeedUser => ({
  user: {
    id: asUserId(demoId(`user:${key}`)),
    firstName,
    lastName,
    initials,
    email,
    mobile,
    role,
    jobTitle,
    active: true,
    createdAt: timeAgo(createdDaysAgo, 8),
  },
  password: DEMO_PASSWORD,
});

export const seedPeople: readonly SeedUser[] = [
  person(
    'master',
    'John',
    'Master',
    'JM',
    'master@eje-demo.local',
    '+27 82 555 0101',
    'master',
    'Service Manager (DEMO)',
    900,
  ),
  person(
    'coordinator',
    'Sarah',
    'Coordinator',
    'SC',
    'coordinator@eje-demo.local',
    '+27 82 555 0102',
    'coordinator',
    'Office Coordinator (DEMO)',
    600,
  ),
  person(
    'tech1',
    'Mike',
    'Technician',
    'MT',
    'technician1@eje-demo.local',
    '+27 83 555 0111',
    'technician',
    'Senior Field Technician (DEMO)',
    500,
  ),
  person(
    'tech2',
    'David',
    'Technician',
    'DT',
    'technician2@eje-demo.local',
    '+27 83 555 0112',
    'technician',
    'Field Technician (DEMO)',
    380,
  ),
  /*
   * A third technician, because two are not enough to prove the visibility
   * rule. EJE-2024 is his, and neither Mike nor David may see it — which is the
   * negative half of the historical-access rule and cannot be demonstrated
   * without somebody uninvolved.
   */
  person(
    'tech3',
    'Peter',
    'Technician',
    'PT',
    'technician3@eje-demo.local',
    '+27 83 555 0113',
    'technician',
    'Workshop Technician (DEMO)',
    240,
  ),
];

export const userId = (key: string) => asUserId(demoId(`user:${key}`));

export const MASTER = userId('master');
export const COORDINATOR = userId('coordinator');
export const TECH1 = userId('tech1');
export const TECH2 = userId('tech2');
export const TECH3 = userId('tech3');
