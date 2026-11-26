import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './oj.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import '@codeos/platform-core/theme-control.css'
import '@codeos/platform-core/global-theme.css'

import '@codeos/platform-core/approved-light.css'

import './immersive.css'
import './workspaceNavigation.css'
