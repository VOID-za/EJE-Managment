import { can } from '../access';
import type { Machine } from '../types/machine';
import type { UserRole } from '../types/user';

/**
 * The machine register.
 *
 * Serial numbers identify a physical asset, so two records claiming the same
 * serial would corrupt machine history. The check lives here rather than in a
 * form so every caller — the Master's Add Machine form, the technician's
 * request, and any future import — is held to the same rule.
 */
export const normaliseSerial = (serialNumber: string): string =>
  serialNumber.trim().toUpperCase().replace(/\s+/g, '');

export const findSerialClash = (
  machines: readonly Machine[],
  serialNumber: string,
  excludingId?: string,
): Machine | null => {
  const needle = normaliseSerial(serialNumber);
  if (needle.length === 0) return null;
  return (
    machines.find(
      (machine) => machine.id !== excludingId && normaliseSerial(machine.serialNumber) === needle,
    ) ?? null
  );
};

/**
 * The office adds directly to the official register. A technician's addition is
 * usable straight away but stays unconfirmed until the office approves it, so
 * nobody on site is blocked waiting for a telephone call.
 *
 * Keyed on the capability rather than on `role === 'master'`: the register is
 * the office's to keep, and a Coordinator keeps it just as a Master does.
 */
export const approvalForNewMachine = (role: UserRole): Machine['approval'] =>
  can(role, 'machines.manage') ? 'approved' : 'pending_approval';

export const pendingMachines = (machines: readonly Machine[]): readonly Machine[] =>
  machines.filter((machine) => machine.approval === 'pending_approval');
