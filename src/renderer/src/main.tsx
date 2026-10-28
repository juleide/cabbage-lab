import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/global.css'
import './styles/layout.css'
import './styles/header.css'
import './styles/controls.css'
import './styles/metrics.css'
import './styles/pressure-map.css'
import './styles/data-actions.css'
import './styles/overlays.css'
import './styles/theme-picker.css'
import './styles/themes.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

import './styles/settings.css'
