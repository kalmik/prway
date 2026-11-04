// Keeps one broken part of the UI from blanking the whole app: shows the error where it happened, with a retry.

import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.label}]`, error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="pad error-boundary">
        <p className="error">
          Something went wrong in {this.props.label}: {this.state.error.message}
        </p>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}
