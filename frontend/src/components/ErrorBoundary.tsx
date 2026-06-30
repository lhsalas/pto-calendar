import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level render-time error boundary. Catches any uncaught error thrown
 * during render (a malformed server payload cast to the wrong shape, a
 * `new Date(invalidString)`-style NaN, etc.) and shows a user-facing
 * fallback with a Reload button instead of an unmount-with-blank-screen.
 *
 * `componentDidCatch` logs to `console.error` so it shows up in the
 * browser dev tools (and can be captured by any error-tracking SDK the
 * operator wires up later). The fallback UI never echoes the raw error
 * body — no info leak.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error', { error, componentStack: info.componentStack });
  }

  private handleReload = (): void => {
    window.location.assign('/calendar');
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main
          role="alert"
          className="flex min-h-full flex-col items-center justify-center bg-surface p-6 dark:bg-surface-dark"
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-surface-3 p-6 shadow-sm dark:border-border-dark dark:bg-surface-dark-3">
            <h1 className="mb-2 font-display text-xl font-semibold tracking-tight text-ink dark:text-ink-dark">
              Something went wrong
            </h1>
            <p className="mb-4 text-sm text-ink-muted dark:text-ink-muted-dark">
              The page failed to render. You can try reloading the calendar — your work so far is
              saved on the server.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="min-h-11 rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
            >
              Back to calendar
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
