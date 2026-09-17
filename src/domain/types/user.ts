import type { IsoDateTime, UserId } from './common';

/**
 * EJE has two roles at launch. The office administrator / sales person uses the
 * Master role. Permission checks resolve through `src/domain/access.ts` rather
 * than comparing role strings inside components, so a third role can be added
 * without touching the UI.
 */
export type UserRole = 'master' | 'technician';

export interface User {
  readonly id: UserId;
  readonly firstName: string;
  readonly lastName: string;
  readonly initials: string;
  readonly email: string;
  readonly mobile: string;
  readonly role: UserRole;
  readonly jobTitle: string;
  readonly active: boolean;
  readonly createdAt: IsoDateTime;
}

export const userFullName = (user: Pick<User, 'firstName' | 'lastName'>): string =>
  `${user.firstName} ${user.lastName}`;
