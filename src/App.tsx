import System from './System.tsx'

// Hour-0 placeholder. Owned by B: pathname switch / → Landing, /app → Caregiver, /admin → Admin.
// /admin shows A's System tab until B's Admin.tsx mounts it as a tab.
export default function App() {
  if (location.pathname === '/admin') return <System />
  return <h1>VitalPower Relay</h1>
}
