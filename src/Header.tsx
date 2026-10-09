import { useEffect, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import type { Persona } from './App.tsx'

type Status = InferResponseType<typeof api.public.status.$get>
const groups: [Persona['personaType'], string][] = [
  ['caregiver', 'Cuidador/a'], ['facility-staff', 'Personal de hogar'], ['self-patient', 'Paciente'],
  ['coordinator', 'Coordinación'], ['admin', 'Administración'],
]

export default function Header({ personas, user, onSwitch }: { personas: Persona[]; user: Persona | null; onSwitch: (userId: number) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const res = await api.public.status.$get()
        if (!res.ok) throw new Error('status')
        const body = await res.json()
        if (active) {
          setStatus(body)
          setError(false)
        }
      } catch {
        if (active) setError(true)
      }
    }
    void load()
    const timer = setInterval(load, 30_000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  return <header className="site-header">
    <div className="header-navigation">
      <a className="brand" href="/">VitalPower Relay</a>
      <nav aria-label="Áreas">
        <a href="/app" aria-current={location.pathname === '/app' ? 'page' : undefined}>Cuidadores</a>
        <a href="/admin" aria-current={location.pathname === '/admin' ? 'page' : undefined}>Coordinación</a>
      </nav>
    </div>
    <div className="feed-status" aria-live="polite">
      {error ? <span className="warning">Sin conexión con el API</span> : status ? <>
        <span className={`badge ${status.mode === 'replay' ? 'replay' : 'live'}`}>{status.mode === 'replay' ? 'REPLAY' : 'EN VIVO'}</span>
        <span className="reading-time">{status.lastReadingAt ? <>Última lectura: <time dateTime={status.lastReadingAt}>{new Date(status.lastReadingAt).toLocaleTimeString('es-PR', { hour: 'numeric', minute: '2-digit' })}</time></> : 'Sin lecturas'}</span>
        {status.stale && <span className="badge stale">Datos desactualizados</span>}
      </> : <span>Cargando…</span>}
    </div>
    <span className="demo-label">DEMO · sin autenticación real</span>
    <label className="persona-switcher">
      Ver como
      <select value={user?.id ?? ''} onChange={(e) => onSwitch(Number(e.target.value))}>
        {!user && <option value="" disabled>Elegir persona…</option>}
        {groups.map(([type, label]) => <optgroup key={type} label={label}>
          {personas.filter((p) => p.personaType === type).map((p) => <option key={p.id} value={p.id}>
            {p.name}{p.orgName ? ` · ${p.orgName}` : ''}{p.orgStatus === 'pending' ? ' (pendiente)' : ''}
          </option>)}
        </optgroup>)}
      </select>
    </label>
  </header>
}
