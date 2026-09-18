'use client';

import { MasterDashboard } from '@/components/dashboard/MasterDashboard';
import { TechnicianDashboard } from '@/components/dashboard/TechnicianDashboard';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * The dashboard is role-driven.
 *
 * The office — Masters and the Coordinator — get the operational overview:
 * workload, exceptions, who is out and what is unassigned. A technician gets
 * their own work and nothing else, because a field tablet showing the whole
 * branch's workload is clutter on a screen used one-handed.
 *
 * The Coordinator deliberately does NOT get the technician dashboard: she runs
 * the office, so she needs the operational view, not a list of jobs to drive to.
 */
const DashboardPage = () => {
  const user = useCurrentUser();
  return user.role === 'technician' ? (
    <TechnicianDashboard user={user} />
  ) : (
    <MasterDashboard user={user} />
  );
};

export default DashboardPage;
