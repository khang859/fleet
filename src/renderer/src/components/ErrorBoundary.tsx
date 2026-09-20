import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createLogger } from '../logger';

const log = createLogger('renderer:error-boundary');

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors so a crashing component shows a recoverable
 * fallback instead of a blank window, and logs the error + component stack to
 * ~/.fleet/logs/ for debugging.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('react render error', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined
    });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center bg-fleet-bg p-8">
        <div className="max-w-md space-y-4 text-center">
          <div className="text-lg font-medium text-fleet-text">Something went wrong</div>
          <p className="text-sm text-fleet-text-muted">
            Fleet hit an unexpected error and this view crashed. The details were saved to your
            local logs. You can reload, or send them to us via Settings → Diagnostics → Report a
            Problem.
          </p>
          <pre className="max-h-32 overflow-auto rounded-md border border-fleet-border bg-fleet-surface p-3 text-left text-xs text-red-400">
            {error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-fleet-surface-3 px-3 py-1.5 text-sm text-fleet-text transition-colors hover:bg-fleet-surface-3 active:scale-[0.97]"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
