import { Component, type ErrorInfo, type ReactNode } from 'react'

type AppErrorBoundaryProps = {
  children: ReactNode
}

type AppErrorBoundaryState = {
  hasError: boolean
  message: string
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    hasError: false,
    message: '',
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || '页面发生异常',
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('AppErrorBoundary caught an error:', error, errorInfo)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-error-screen">
          <section className="app-error-card">
            <span>Runtime Error</span>
            <h2>页面刚刚遇到了异常，没有正常渲染出来。</h2>
            <p>{this.state.message}</p>
            <button type="button" className="primary-button" onClick={this.handleReload}>
              重新加载页面
            </button>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}
