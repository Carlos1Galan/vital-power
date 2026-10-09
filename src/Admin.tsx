import { useState } from 'react'
import type { Persona } from './App.tsx'
import System from './System.tsx'
import CallList from './CallList.tsx'

// Platform admin view (/admin): A's System screen plus every open case on the island.
// The admin only watches the cases: claiming, confirming and briefing belong to the organizations.
export default function Admin({ user }: { user: Persona }) {
  const [tab, setTab] = useState<'system' | 'calls'>('system')

  return <section>
    <h1>Administración</h1>
    <p className="org-line">Lecturas de LUMA, organizaciones y todos los casos abiertos.</p>
    <div className="tabs" aria-label="Vistas de administración">
      <button aria-pressed={tab === 'system'} onClick={() => setTab('system')}>Sistema</button>
      <button aria-pressed={tab === 'calls'} onClick={() => setTab('calls')}>Todos los casos</button>
    </div>
    {tab === 'system' ? <System /> : <CallList user={user} />}
  </section>
}
