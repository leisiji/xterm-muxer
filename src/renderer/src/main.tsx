import { createRoot } from 'react-dom/client'
import 'xterm/css/xterm.css'
import './styles.css'
import { App } from './app'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(<App />)
}
