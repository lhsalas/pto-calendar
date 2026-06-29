import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastProvider';
import { AppRoutes } from './routes/AppRoutes';
import { ToastViewport } from './components/common/ToastViewport';

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
          <ToastViewport />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
