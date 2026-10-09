import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './farmer/FarmerRoot'

async function start() {
  // The public demo build answers the API from a recording in the browser (src/demo/replay.ts).
  if (import.meta.env.VITE_DEMO_STATIC === '1') await (await import('./demo/replay')).installReplay()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
void start()
