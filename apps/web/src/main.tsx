import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import { initAppearance } from './typography.ts'

// Before the first paint, so a saved light theme or large text never flashes the defaults.
initAppearance()

createRoot(document.getElementById('root')!).render(<App />)
