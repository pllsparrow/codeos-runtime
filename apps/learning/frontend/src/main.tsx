import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { loadContentRegistry } from './contentRegistry'
import './styles.css'
import './theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

const reactRoot = createRoot(root)
async function start() {
  reactRoot.render(<main className="course-directory" role="status">Loading CodeOS content…</main>)
  try { await loadContentRegistry(); reactRoot.render(<StrictMode><App /></StrictMode>) }
  catch (error) { reactRoot.render(<main className="course-directory" role="alert"><h1>Content unavailable</h1><p>{error instanceof Error ? error.message : 'Unable to load published content'}</p><button onClick={() => void start()}>Retry content</button></main>) }
}
void start()

import '@codeos/platform-core/theme-control.css'
import '@codeos/platform-core/global-theme.css'

import './learningLight.css'

import '@codeos/platform-core/approved-light.css'
