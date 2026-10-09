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
    <h1>Lista de llamadas</h1>
    <p className="org-line">{user.orgName ?? 'Administración de la plataforma'}</p>
    <div className="tabs" aria-label="Vistas de coordinación">
      <button aria-pressed={tab === 'calls'} onClick={() => setTab('calls')}>Llamadas</button>
      {user.role === 'admin' && <button aria-pressed={tab === 'system'} onClick={() => setTab('system')}>Sistema</button>}
    </div>
    {tab === 'system' && user.role === 'admin' ? <System /> : <p className="card empty">Aquí va a aparecer a quién llamar primero, y por qué.</p>}
  </section>
}
