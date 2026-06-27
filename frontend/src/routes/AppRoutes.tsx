import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from '../pages/LoginPage';
import { CalendarPage } from '../pages/CalendarPage';
import { RequireAuth } from './RequireAuth';

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/calendar"
        element={
          <RequireAuth>
            <CalendarPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/calendar" replace />} />
    </Routes>
  );
}
