import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastProvider';
import { AppRoutes } from './routes/AppRoutes';
import { ToastViewport } from './components/common/ToastViewport';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AuthProvider>
          <ToastProvider>
            <AppRoutes />
            <ToastViewport />
          </ToastProvider>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
