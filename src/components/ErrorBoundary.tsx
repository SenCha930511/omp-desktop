import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  /** Static fallback, or a factory receiving a reset callback that re-attempts rendering. */
  fallback: ReactNode | ((reset: () => void) => ReactNode)
  onCatch?(error: unknown, info: ErrorInfo): void
  children: ReactNode
}

interface ErrorBoundaryState { failed: boolean }

/** Catches render failures so one broken subtree cannot blank the whole app. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState { return { failed: true } }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('OMP Desktop rendering failed:', error, info.componentStack)
    this.props.onCatch?.(error, info)
  }

  private readonly reset = (): void => { this.setState({ failed: false }) }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { fallback } = this.props
    return typeof fallback === 'function' ? fallback(this.reset) : fallback
  }
}
