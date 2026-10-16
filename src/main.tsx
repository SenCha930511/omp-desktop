import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { saveComposerDraftFromDom } from './lib/composer-draft'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('OMP Desktop root element was not found')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary
      onCatch={saveComposerDraftFromDom}
      fallback={(
        <div className="empty-state app-error-fallback" role="alert">
          <h2>OMP Desktop hit an unexpected error</h2>
          <p>Reload to continue. Any message you were typing is preserved.</p>
          <div className="empty-state__action">
            <button type="button" className="button button--primary" onClick={() => window.location.reload()}>Reload OMP Desktop</button>
          </div>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
