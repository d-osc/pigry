/** App-wide error boundary — a screen crash shows the error and a reload
 * action instead of blanking the whole window. */
import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      const error = this.state.error;
      return (
        <div className="error-boundary" role="alert">
          <p className="error-boundary__title">
            This screen crashed while rendering — the rest of the app is unaffected below.
          </p>
          <pre className="error-boundary__stack">{String(error.stack || error.message)}</pre>
          <div className="error-boundary__actions">
            <button
              type="button"
              onClick={() => {
                this.setState({ error: null });
              }}
            >
              Try again
            </button>
            <button type="button" onClick={() => location.reload()}>
              Reload app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
