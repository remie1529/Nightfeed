import React from 'react';

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[Nightfeed UI crash]', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--bg, #121212)',
          color: 'var(--text, #e8e6e3)',
          padding: 24,
        }}
      >
        <div
          style={{
            maxWidth: 520,
            background: 'var(--bg-elevated, #1a1a1a)',
            border: '1px solid var(--border, #2a2a2a)',
            borderRadius: 12,
            padding: 24,
          }}
        >
          <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
          <p style={{ color: 'var(--text-dim, #9a9690)', lineHeight: 1.5 }}>
            Nightfeed hit an unexpected rendering error. Reloading usually recovers cleanly.
          </p>
          <pre
            style={{
              background: '#0e0e0e',
              padding: 12,
              borderRadius: 8,
              overflowX: 'auto',
              fontSize: 12,
              color: '#f29b9b',
            }}
          >
            {this.state.error.message || String(this.state.error)}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              type="button"
              className="primary"
              onClick={() => window.location.reload()}
            >
              Reload Nightfeed
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
            >
              Try to continue
            </button>
          </div>
        </div>
      </div>
    );
  }
}
