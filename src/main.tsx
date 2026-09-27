import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import GhostOverlay from './components/GhostOverlay'
import './index.css'

function Root(): JSX.Element {
  const [hash, setHash] = useState(() => window.location.hash)

  useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  if (hash === '#overlay') {
    return <GhostOverlay />
  }

  return <App />
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
