import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Keeps one broken page from blanking the whole app: the menu and top bar stay, and the page area says
 * what happened. Switching page or site remounts the page and clears it (the shell keys the outlet).
 */
export class PageErrorBoundary extends Component<{ children: ReactNode; message: string }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('page.render_failed', error, info.componentStack)
  }

  render() {
    if (this.state.failed) return <p className="page-error" role="alert">{this.props.message}</p>
    return this.props.children
  }
}
