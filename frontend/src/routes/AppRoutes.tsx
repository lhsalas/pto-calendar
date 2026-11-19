import type { JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from '../pages/LoginPage';
import { SetupAccountPage } from '../pages/SetupAccountPage';
import { CalendarPage } from '../pages/CalendarPage';
import { TokenSettingsPage } from '../pages/settings/TokenSettingsPage';
import { AdminUsersPage } from '../pages/admin/AdminUsersPage';
import { AdminHolidaysPage } from '../pages/admin/AdminHolidaysPage';
import { RequireAuth } from './RequireAuth';
import { RequireRole } from '../components/guards/RequireRole';
import { useTokenIssuanceGuard } from '../hooks/useTokenIssuanceGuard';

export function AppRoutes(): JSX.Element {
  // The non-secret retry guard belongs to the router, not the settings pane.
  const tokenIssuance = useTokenIssuanceGuard();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup-account" element={<SetupAccountPage />} />
      <Route
        path="/calendar"
        element={
          <RequireAuth>
            <CalendarPage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/tokens"
        element={
          <RequireAuth>
            <TokenSettingsPage guard={tokenIssuance} />
          </RequireAuth>
        }
      />
      <Route
        path="/admin/users"
        element={
          <RequireRole role="team_lead">
            <AdminUsersPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin/holidays"
        element={
          <RequireRole role="team_lead">
            <AdminHolidaysPage />
          </RequireRole>
        }
      />
      <Route path="*" element={<Navigate to="/calendar" replace />} />
    </Routes>
  );
}
