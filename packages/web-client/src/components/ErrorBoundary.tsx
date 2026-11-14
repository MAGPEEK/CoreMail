import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** When this value changes, a caught error is reset (e.g. the route path) */
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey: string | undefined;
}

/** Catches render errors so a broken view does not leave a white page. */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Navigating elsewhere clears the error
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="flex-1 p-8 max-w-2xl mx-auto mt-16">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 space-y-3">
            <h2 className="text-lg font-semibold text-red-800 dark:text-red-200">Diese Ansicht konnte nicht angezeigt werden</h2>
            <p className="text-sm text-red-700 dark:text-red-300">{this.state.error.message}</p>
            <div className="flex gap-2">
              <button onClick={() => this.setState({ error: null })} className="btn-secondary text-sm">
                Erneut versuchen
              </button>
              <button onClick={() => window.location.reload()} className="btn-secondary text-sm">
                Seite neu laden
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
