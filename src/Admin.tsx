import { useState } from 'react'
import type { Persona } from './App.tsx'
import System from './System.tsx'

export default function Admin({ user }: { user: Persona }) {
  const [tab, setTab] = useState<'calls' | 'system'>('calls')
  if (user.role === 'coordinator' && user.orgStatus === 'pending') return <section className="card notice">
    <h1>Su organización está pendiente de aprobación</h1>
    <p>{user.orgName} podrá ver la lista de llamadas cuando un administrador apruebe el registro.</p>
  </section>

  return <section>
    <span className="viewing-as">Viendo como: {user.name}{user.orgName ? ` · ${user.orgName}` : ''}</span>
    <h1>Coordinación</h1>
    <div className="tabs" aria-label="Vistas de coordinación">
      <button aria-pressed={tab === 'calls'} onClick={() => setTab('calls')}>Lista de llamadas</button>
      {user.role === 'admin' && <button aria-pressed={tab === 'system'} onClick={() => setTab('system')}>Sistema</button>}
    </div>
    {tab === 'system' && user.role === 'admin' ? <System /> : <p className="card empty">Lista de llamadas: próximamente.</p>}
  </section>
}
