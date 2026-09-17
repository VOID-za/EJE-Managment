'use client';

import { MasterDashboard } from '@/components/dashboard/MasterDashboard';
import { TechnicianDashboard } from '@/components/dashboard/TechnicianDashboard';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * The dashboard is role-driven: Masters see the operational overview,
 * technicians see their own work.
 */
const DashboardPage = () => {
  const user = useCurrentUser();
  return user.role === 'master' ? (
    <MasterDashboard user={user} />
  ) : (
    <TechnicianDashboard user={user} />
  );
};

export default DashboardPage;
