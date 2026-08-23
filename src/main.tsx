import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App.tsx'

function resolveRouterBasename() {
  const runtime = (window as typeof window & {
    __OCTOPUS_SERVICE__?: { uiBase?: string }
  }).__OCTOPUS_SERVICE__
  const uiBase = typeof runtime?.uiBase === 'string' ? runtime.uiBase.trim() : ''
  if (!uiBase || !uiBase.startsWith('/')) return undefined
  return uiBase.replace(/\/+$/, '') || undefined
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter basename={resolveRouterBasename()}>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
)
